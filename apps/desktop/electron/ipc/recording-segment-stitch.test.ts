import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionTimelineEvent } from "./action-timeline";
import type {
  RecordingCheckpointAssemblySnapshot,
  SceneSegmentAttempt,
  StepCheckpoint,
} from "./recording-checkpoints";
import {
  assembleRecordingSegments,
  buildRevisionMuxArgs,
  buildSegmentAudioFfmpegArgs,
  buildSegmentFfmpegArgs,
  canonicalAssemblyJson,
  classifySegmentCompatibility,
  prepareLiveRepairAssembly,
  probeSegmentWithFfmpeg,
  recordingAssemblyInputSha256,
  RecordingAssemblyError,
  type RecordingAssemblySpec,
  rebaseActionEvents,
  rebaseStepCheckpoints,
  recordingAssemblyDigest,
  type SegmentSelection,
  type SegmentStreamProbe,
  segmentOffsetMap,
  validateRecordingAssemblySpec,
} from "./recording-segment-stitch";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function selection(ordinal: number, content = `segment-${ordinal}`): SegmentSelection {
  return {
    scene_id: `scene-${ordinal}`,
    scene_ordinal: ordinal,
    attempt_id: `attempt-${ordinal}`,
    media_path: `segments/scene-${ordinal}.mp4`,
    media_sha256: sha(content),
    resolution: { width: 1920, height: 1080 },
    effective_fps: 30,
    time_base: "1/30000",
    capture_backend: "electron_author_preview",
    source_frame_range: {
      start: (ordinal - 1) * 300,
      end: (ordinal - 1) * 300 + 29,
    },
    source_pts_range_us: {
      start: (ordinal - 1) * 10_000_000,
      end: (ordinal - 1) * 10_000_000 + 999_999,
    },
  };
}

function spec(selections = [selection(1), selection(2)]): RecordingAssemblySpec {
  return {
    policy_version: 1,
    source_take_id: "take-source",
    selections,
    output: {
      width: 1920,
      height: 1080,
      fps: 30,
      video_codec: "h264",
      pixel_format: "yuv420p",
      audio_codec: "aac",
      audio_sample_rate: 48_000,
      audio_channel_layout: "stereo",
    },
    required_tracks: ["microphone"],
    optional_tracks: ["tab"],
    toolchain: { ffmpeg: "fixture-1" },
  };
}

function probe(overrides: Partial<SegmentStreamProbe["video"]> = {}): SegmentStreamProbe {
  return {
    duration_us: 1_000_000,
    video: {
      codec: "h264",
      profile: "High",
      pixel_format: "yuv420p",
      color_metadata: "bt709",
      width: 1920,
      height: 1080,
      effective_fps: 30,
      time_base: "1/30000",
      ...overrides,
    },
    audio: [
      { role: "microphone", codec: "aac", sample_rate: 48_000, channel_layout: "stereo" },
      { role: "tab", codec: "aac", sample_rate: 48_000, channel_layout: "stereo" },
    ],
  };
}

async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-stitch-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "segments"), { recursive: true });
  await fs.writeFile(path.join(dir, "segments", "scene-1.mp4"), "segment-1");
  await fs.writeFile(path.join(dir, "segments", "scene-2.mp4"), "segment-2");
  return dir;
}

function runFfmpeg(args: string[]): Promise<void> {
  const binary = ffmpegPath;
  if (!binary) return Promise.reject(new Error("ffmpeg unavailable"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited ${code ?? "signal"}`));
    });
  });
}

describe("recording segment assembly", () => {
  it("serializes and hashes the assembly spec canonically", () => {
    const first = spec();
    const reordered = JSON.parse(JSON.stringify(first)) as RecordingAssemblySpec;
    reordered.toolchain = { ffmpeg: "fixture-1" };

    expect(canonicalAssemblyJson(first)).toBe(canonicalAssemblyJson(reordered));
    expect(recordingAssemblyDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(recordingAssemblyDigest(first)).toBe(recordingAssemblyDigest(reordered));
  });

  it("requires exactly one ordered selection for every scene", () => {
    expect(() => validateRecordingAssemblySpec(spec([selection(2)]))).toThrowError(
      expect.objectContaining({ reason: "scene_selection_invalid" }),
    );
    expect(() => validateRecordingAssemblySpec(spec([selection(1), selection(1)]))).toThrowError(
      expect.objectContaining({ reason: "scene_selection_invalid" }),
    );
  });

  it.each([
    ["resolution_mismatch", { width: 1280 }, {}],
    ["fps_mismatch", { effective_fps: 29.97 }, {}],
    ["time_base_mismatch", { time_base: "1/90000" }, {}],
    ["capture_backend_mismatch", {}, { capture_backend: "native" }],
  ] as const)("rejects %s before FFmpeg", (reason, videoOverride, selectionOverride) => {
    const selections = [selection(1), { ...selection(2), ...selectionOverride }];
    expect(() =>
      classifySegmentCompatibility(spec(selections), [probe(), probe(videoOverride)]),
    ).toThrowError(expect.objectContaining({ reason }));
  });

  it("normalizes supported codec differences and rejects missing required audio", () => {
    expect(classifySegmentCompatibility(spec(), [probe(), probe({ codec: "hevc" })])).toBe(
      "normalize",
    );
    const missingAudio = { ...probe(), audio: [] };
    expect(() => classifySegmentCompatibility(spec(), [probe(), missingAudio])).toThrowError(
      expect.objectContaining({ reason: "required_audio_missing" }),
    );
  });

  it("uses one cumulative map for action landmarks and checkpoints", () => {
    const offsets = segmentOffsetMap(spec().selections, [
      probe(),
      { ...probe(), duration_us: 2_000_000 },
    ]);
    const action: ActionTimelineEvent = {
      step_id: "step-2",
      ordinal: 2,
      verb: "click",
      t_start_ms: 10_010,
      t_action_ms: 10_020,
      t_end_ms: 10_030,
      target: null,
      secondary_target: null,
      pointer: null,
      cursor_path: {
        interpolation: "media-frame-linear-v1",
        samples: [{ frame_index: 301, pts_us: 10_033_333, x: 1, y: 2 }],
        arrival: { frame_index: 301, pts_us: 10_033_333 },
      },
      input_landmarks: { action: { frame_index: 302, pts_us: 10_066_667 } },
      presentation: {
        status: "presented",
        first_post_input_frame: { frame_index: 303, pts_us: 10_100_000 },
      },
    };
    const checkpoint: StepCheckpoint = {
      scene_id: "scene-2",
      scene_ordinal: 2,
      attempt_id: "attempt-2",
      step_id: "step-2",
      step_ordinal: 1,
      command_verb: "click",
      status: "succeeded",
      frame_range: { start: 301, end: 303 },
      pts_range_us: { start: 10_033_333, end: 10_100_000 },
      action_event_id: "event-2",
      state_hash: sha("state"),
      health: {},
    };

    const [rebasedAction] = rebaseActionEvents({ "attempt-2": [action] }, offsets);
    const [rebasedCheckpoint] = rebaseStepCheckpoints({ "attempt-2": [checkpoint] }, offsets);

    expect(offsets[1]).toMatchObject({
      offset_us: 1_000_000,
      frame_offset: 30,
      source_frame_start: 300,
      source_pts_start_us: 10_000_000,
    });
    expect(rebasedAction?.input_landmarks?.action).toEqual({ frame_index: 32, pts_us: 1_066_667 });
    expect(rebasedAction?.presentation?.first_post_input_frame?.pts_us).toBe(1_100_000);
    expect(rebasedCheckpoint?.frame_range).toEqual({ start: 31, end: 33 });
    expect(rebasedCheckpoint?.pts_range_us).toEqual({ start: 1_033_333, end: 1_100_000 });
  });

  it("prepares the latest committed attempt for every repaired scene", async () => {
    const takeRoot = await fixture();
    const attempt = (
      sceneOrdinal: number,
      attemptId: string,
      status: SceneSegmentAttempt["status"],
    ): SceneSegmentAttempt => ({
      scene_id: `scene-${sceneOrdinal}`,
      scene_ordinal: sceneOrdinal,
      attempt_id: attemptId,
      status,
      media_path: `segments/scene-${sceneOrdinal}.mp4`,
      media_clock: {
        clock: "encoded_video_pts",
        unit: "us",
        fpsNum: 30,
        fpsDen: 1,
        originFrame: 0,
        frameCount: 30,
        nextFrameIndex: 30,
        nextPtsUs: 1_000_000,
        durationUs: 1_000_000,
        state: "running",
      },
      source_frame_range: { start: (sceneOrdinal - 1) * 300, end: (sceneOrdinal - 1) * 300 + 29 },
      source_pts_range_us: {
        start: (sceneOrdinal - 1) * 10_000_000,
        end: (sceneOrdinal - 1) * 10_000_000 + 999_999,
      },
      health: {},
    });
    const snapshot: RecordingCheckpointAssemblySnapshot = {
      attempts: [
        attempt(1, "attempt-1", "committed"),
        attempt(2, "attempt-failed", "failed"),
        attempt(2, "attempt-2", "committed"),
      ],
      checkpoints_by_attempt: {
        "attempt-1": [],
        "attempt-failed": [],
        "attempt-2": [],
      },
      actions_by_attempt: {
        "attempt-1": [],
        "attempt-failed": [],
        "attempt-2": [],
      },
    };

    const prepared = await prepareLiveRepairAssembly({
      takeRoot,
      sourceTakeId: "take-source",
      snapshot,
      output: spec().output,
      captureBackend: "electron_author_preview",
      toolchain: { ffmpeg: "fixture-1" },
      probe: async () => probe(),
    });

    expect(prepared?.spec.selections.map((item) => item.attempt_id)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
    expect(prepared?.actionsByAttempt).not.toHaveProperty("attempt-failed");
  });

  it("builds deterministic stream-copy and normalization arguments", () => {
    expect(buildSegmentFfmpegArgs("inputs.txt", "out.mp4", spec(), "stream_copy")).toContain(
      "copy",
    );
    const normalized = buildSegmentFfmpegArgs("inputs.txt", "out.mp4", spec(), "normalize");
    expect(normalized).toEqual(expect.arrayContaining(["libx264", "yuv420p", "48000"]));
  });

  it("cuts master-clock audio ranges without blind shortest truncation", () => {
    const assembly = spec();
    const offsets = segmentOffsetMap(assembly.selections, [
      probe(),
      { ...probe(), duration_us: 2_000_000 },
    ]);
    const source = {
      role: "microphone",
      requirement: "required" as const,
      media_path: "audio/microphone.webm",
      media_sha256: sha("microphone"),
      first_pts_us: 250_000,
    };
    const audioArgs = buildSegmentAudioFfmpegArgs(
      "/take/audio/microphone.webm",
      "/revision/audio/microphone.m4a",
      source,
      offsets,
      assembly.output,
    );
    const muxArgs = buildRevisionMuxArgs(
      "/revision/video-only.mp4",
      "/revision/audio/compatibility.m4a",
      "/revision/video.mp4",
      3_000_000,
    );

    expect(audioArgs.join(" ")).toContain("atrim=start=10.000000:duration=2.000000");
    expect(audioArgs).not.toContain("-shortest");
    expect(muxArgs).toEqual(expect.arrayContaining(["-t", "3.000000"]));
    expect(muxArgs).not.toContain("-shortest");
  });

  it("assembles immutable external audio stems and a compatibility mix", async () => {
    const takeRoot = await fixture();
    await fs.mkdir(path.join(takeRoot, "audio"), { recursive: true });
    await fs.writeFile(path.join(takeRoot, "audio", "microphone.webm"), "microphone");
    const assembly: RecordingAssemblySpec = {
      ...spec(),
      optional_tracks: ["tab"],
      audio_sources: [
        {
          role: "microphone",
          requirement: "required",
          media_path: "audio/microphone.webm",
          media_sha256: sha("microphone"),
          first_pts_us: 250_000,
        },
        {
          role: "tab",
          requirement: "optional",
          media_path: null,
          media_sha256: null,
          first_pts_us: 0,
        },
      ],
    };
    const runFfmpeg = vi.fn(async (args: string[]) => {
      const output = args.at(-1);
      if (!output) throw new Error("missing output");
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, "assembled");
    });
    const videoOnlyProbe = { ...probe(), audio: [] };

    const revision = await assembleRecordingSegments({
      takeRoot,
      spec: assembly,
      probe: async () => videoOnlyProbe,
      runFfmpeg,
    });

    expect(runFfmpeg).toHaveBeenCalledTimes(5);
    expect(revision.audio_paths).toEqual({
      microphone: `revisions/${revision.revision_id}/audio/microphone.m4a`,
      tab: `revisions/${revision.revision_id}/audio/tab.m4a`,
    });
    expect(revision.compatibility_audio_path).toBe(
      `revisions/${revision.revision_id}/audio/compatibility.m4a`,
    );
  });

  it(
    "assembles a real three-scene microphone revision on the encoded-video clock",
    async () => {
      if (!ffmpegPath) return;
      const takeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-stitch-golden-"));
      tempDirs.push(takeRoot);
      const segmentDir = path.join(takeRoot, "segments");
      const audioDir = path.join(takeRoot, "audio");
      await fs.mkdir(segmentDir, { recursive: true });
      await fs.mkdir(audioDir, { recursive: true });
      const colors = ["red", "green", "blue"];
      const segmentPaths: string[] = [];
      for (const [index, color] of colors.entries()) {
        const output = path.join(segmentDir, `scene-${index + 1}.mp4`);
        await runFfmpeg([
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=320x240:r=30:d=1`,
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          output,
        ]);
        segmentPaths.push(output);
      }
      const microphonePath = path.join(audioDir, "microphone.m4a");
      await runFfmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=4",
        "-c:a",
        "aac",
        microphonePath,
      ]);
      const probes = await Promise.all(segmentPaths.map(probeSegmentWithFfmpeg));
      const sourceStarts = [0, 2_000_000, 3_000_000];
      const selections: SegmentSelection[] = await Promise.all(
        segmentPaths.map(async (mediaPath, index) => ({
          scene_id: `scene-${index + 1}`,
          scene_ordinal: index + 1,
          attempt_id: `attempt-${index + 1}`,
          media_path: path.relative(takeRoot, mediaPath).split(path.sep).join("/"),
          media_sha256: await recordingAssemblyInputSha256(mediaPath),
          resolution: { width: 320, height: 240 },
          effective_fps: probes[index]?.video.effective_fps ?? 30,
          time_base: probes[index]?.video.time_base ?? "1/15360",
          capture_backend: "electron_author_preview",
          source_frame_range: {
            start: Math.round((sourceStarts[index] ?? 0) * 30 / 1_000_000),
            end: Math.round((sourceStarts[index] ?? 0) * 30 / 1_000_000) + 29,
          },
          source_pts_range_us: {
            start: sourceStarts[index] ?? 0,
            end: (sourceStarts[index] ?? 0) + 999_999,
          },
        })),
      );
      const inputHashes = await Promise.all(segmentPaths.map(recordingAssemblyInputSha256));
      const revision = await assembleRecordingSegments({
        takeRoot,
        spec: {
          policy_version: 1,
          source_take_id: "take-golden",
          selections,
          output: {
            width: 320,
            height: 240,
            fps: 30,
            video_codec: "h264",
            pixel_format: "yuv420p",
            audio_codec: "aac",
            audio_sample_rate: 48_000,
            audio_channel_layout: "stereo",
          },
          required_tracks: ["microphone"],
          optional_tracks: [],
          audio_sources: [
            {
              role: "microphone",
              requirement: "required",
              media_path: "audio/microphone.m4a",
              media_sha256: await recordingAssemblyInputSha256(microphonePath),
              first_pts_us: 0,
            },
          ],
          toolchain: { ffmpeg: path.basename(ffmpegPath) },
        },
      });
      const outputProbe = await probeSegmentWithFfmpeg(path.join(takeRoot, revision.output_path));

      expect(outputProbe.duration_us).toBeGreaterThanOrEqual(2_900_000);
      expect(outputProbe.duration_us).toBeLessThanOrEqual(3_100_000);
      expect(outputProbe.audio).toHaveLength(1);
      await expect(Promise.all(segmentPaths.map(recordingAssemblyInputSha256))).resolves.toEqual(
        inputHashes,
      );
    },
    30_000,
  );

  it("commits a revision manifest last, preserves inputs, and is idempotent", async () => {
    const takeRoot = await fixture();
    const inputBefore = await Promise.all(
      spec().selections.map((item) => fs.readFile(path.join(takeRoot, item.media_path))),
    );
    const runFfmpeg = vi.fn(async (args: string[]) => {
      await fs.writeFile(args.at(-1) as string, "assembled");
    });
    const probeFn = vi.fn(async () => probe());

    const first = await assembleRecordingSegments({
      takeRoot,
      spec: spec(),
      probe: probeFn,
      runFfmpeg,
    });
    const second = await assembleRecordingSegments({
      takeRoot,
      spec: spec(),
      probe: probeFn,
      runFfmpeg,
    });

    expect(second.revision_id).toBe(first.revision_id);
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await fs.readFile(path.join(takeRoot, "revisions", "current.json"), "utf8")),
    ).toMatchObject({
      revision_id: first.revision_id,
      assembly_sha256: recordingAssemblyDigest(spec()),
    });
    const inputAfter = await Promise.all(
      spec().selections.map((item) => fs.readFile(path.join(takeRoot, item.media_path))),
    );
    expect(inputAfter).toEqual(inputBefore);
  });

  it("rejects a changed input before FFmpeg and leaves the current revision unchanged", async () => {
    const takeRoot = await fixture();
    const runFfmpeg = vi.fn(async (args: string[]) =>
      fs.writeFile(args.at(-1) as string, "assembled"),
    );
    const first = await assembleRecordingSegments({
      takeRoot,
      spec: spec(),
      probe: async () => probe(),
      runFfmpeg,
    });
    await fs.writeFile(path.join(takeRoot, "segments", "scene-2.mp4"), "changed");

    await expect(
      assembleRecordingSegments({
        takeRoot,
        spec: { ...spec(), toolchain: { ffmpeg: "fixture-2" } },
        probe: async () => probe(),
        runFfmpeg,
      }),
    ).rejects.toMatchObject({ reason: "input_hash_mismatch" });
    expect(
      JSON.parse(await fs.readFile(path.join(takeRoot, "revisions", "current.json"), "utf8")),
    ).toMatchObject({
      revision_id: first.revision_id,
    });
  });

  it("does not publish a staged revision when failure is injected before commit", async () => {
    const takeRoot = await fixture();
    const runFfmpeg = vi.fn(async (args: string[]) =>
      fs.writeFile(args.at(-1) as string, "assembled"),
    );

    await expect(
      assembleRecordingSegments({
        takeRoot,
        spec: spec(),
        probe: async () => probe(),
        runFfmpeg,
        failureInjector: (stage) => {
          if (stage === "before_commit") throw new RecordingAssemblyError("revision_commit_failed");
        },
      }),
    ).rejects.toMatchObject({ reason: "revision_commit_failed" });
    await expect(
      fs.readFile(path.join(takeRoot, "revisions", "current.json"), "utf8"),
    ).rejects.toThrow();
  });
});

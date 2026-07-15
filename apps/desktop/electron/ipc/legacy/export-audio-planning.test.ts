import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExportCompositionGraphV4, ExportVideoNode } from "@storycapture/shared-types";
import ffmpegPath from "ffmpeg-static";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildExportAudioPlan,
  EXPORT_AUDIO_DUCKING,
  EXPORT_AUDIO_LIMIT_DBFS,
  type ExportAudioPlan,
} from "./export-audio-planning";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function source(
  id: string,
  clipId: string,
  sourcePath: string,
  timelineStartMs: number,
  durationMs: number,
  sourceTimeMap?: Extract<ExportVideoNode, { type: "source" }>["source_time_map"],
): Extract<ExportVideoNode, { type: "source" }> {
  return {
    type: "source",
    id,
    clip_id: clipId,
    path: sourcePath,
    pts_offset_ms: timelineStartMs,
    timeline_start_ms: timelineStartMs,
    duration_ms: durationMs,
    source_time_map: sourceTimeMap,
  };
}

function graph(): ExportCompositionGraphV4 {
  return {
    schema_version: 4,
    output_width: 1920,
    output_height: 1080,
    output_fps: 60,
    duration_ms: 4_000,
    video: [
      source("source-a", "video-a", "/fixtures/a.mp4", 0, 2_000, {
        version: 1,
        segments: [
          {
            kind: "media",
            sourceStartUs: 0,
            sourceEndUs: 800_000,
            timelineStartMs: 0,
            timelineEndMs: 500,
          },
          {
            kind: "hold",
            sourcePtsUs: 800_000,
            timelineStartMs: 500,
            timelineEndMs: 750,
            reason: "cursor-motion",
          },
          {
            kind: "media",
            sourceStartUs: 800_000,
            sourceEndUs: 2_050_000,
            timelineStartMs: 750,
            timelineEndMs: 2_000,
          },
        ],
      }),
      source("source-b", "video-b", "/fixtures/b.mp4", 2_000, 2_000),
      {
        type: "transition",
        id: "transition-a-b",
        kind: "fade",
        duration_ms: 500,
        offset_ms: 1_500,
        from_source_id: "source-a",
        to_source_id: "source-b",
      },
    ],
    audio: [
      {
        type: "sound",
        id: "sound-bgm",
        clip_id: "bgm-1",
        kind: "bgm",
        path: "/fixtures/bgm.wav",
        t_start_ms: 0,
        duration_ms: 4_000,
        gain: 0.25,
        source_binding: null,
      },
      {
        type: "sound",
        id: "sound-sfx",
        clip_id: "sfx-1",
        kind: "sfx",
        path: "/fixtures/click.wav",
        t_start_ms: 750,
        duration_ms: 200,
        gain: 1.2,
        source_binding: null,
      },
      {
        type: "sound",
        id: "sound-voice",
        clip_id: "voice-1",
        kind: "voiceover",
        path: "/fixtures/voice.wav",
        t_start_ms: 1_000,
        duration_ms: 1_000,
        gain: 0.8,
        source_binding: { kind: "story-voiceover", stepId: "step-1", ordinal: 0 },
      },
    ],
  };
}

function mixedPlan(
  value = graph(),
  sourceAudio: Readonly<Record<string, boolean>> = {
    "source-a": true,
    "source-b": true,
  },
): Extract<ExportAudioPlan, { kind: "mixed" }> {
  const plan = buildExportAudioPlan({
    graph: value,
    output: { format: "mp4", bitrateKbps: 192, channels: 2, sampleRateHz: 48_000 },
    sourceAudio,
  });
  if (plan.kind !== "mixed") {
    throw new Error(`expected mixed audio plan: ${JSON.stringify(plan.diagnostics)}`);
  }
  return plan;
}

function entry(plan: ExportAudioPlan, nodeId: string) {
  const registration = plan.registry.find((candidate) => candidate.nodeId === nodeId);
  if (!registration) throw new Error(`missing registration for ${nodeId}`);
  return registration;
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("export audio planning", () => {
  it("assigns deterministic input labels and indexes independent of graph array order", () => {
    const first = mixedPlan();
    const shuffled = graph();
    shuffled.video.reverse();
    shuffled.audio.reverse();
    const second = mixedPlan(shuffled);

    expect(second.registry).toEqual(first.registry);
    expect(second.inputArgs).toEqual(first.inputArgs);
    expect(second.filterComplex).toBe(first.filterComplex);
    expect(new Set(first.registry.map((registration) => registration.label)).size).toBe(
      first.registry.length,
    );
    expect(
      first.registry.every((registration) => /^[a-z]+_[a-f0-9]{16}$/.test(registration.label)),
    ).toBe(true);
    expect(first.registry.map((registration) => registration.inputIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it("maps source media, tempo changes, holds, and exact clip duration", () => {
    const plan = mixedPlan();
    const label = entry(plan, "source-a").label;
    const filter = plan.filterComplex ?? "";

    expect(filter).toContain("atrim=start=0.000000:end=0.800000");
    expect(filter).toContain("atempo=1.6");
    expect(filter).toContain(
      `anullsrc=r=48000:cl=stereo,atrim=duration=0.250000,asetpts=PTS-STARTPTS[${label}_segment_1]`,
    );
    expect(filter).toContain("concat=n=3:v=0:a=1");
    expect(filter).toContain("apad=pad_dur=2.000000,atrim=duration=2.000000");
  });

  it("loops only BGM and trims, gains, and delays every sound clip", () => {
    const plan = mixedPlan();
    const filter = plan.filterComplex ?? "";
    const bgm = entry(plan, "sound-bgm");
    const sfx = entry(plan, "sound-sfx");
    const voice = entry(plan, "sound-voice");

    expect(plan.inputArgs).toEqual([
      "-i",
      "/fixtures/a.mp4",
      "-i",
      "/fixtures/b.mp4",
      "-t",
      "4.000000",
      "-i",
      "/fixtures/bgm.wav",
      "-t",
      "0.200000",
      "-i",
      "/fixtures/click.wav",
      "-t",
      "1.000000",
      "-i",
      "/fixtures/voice.wav",
    ]);
    expect(filter).toContain(`[${bgm.streamLabel}]asetpts=PTS-STARTPTS`);
    expect(occurrences(filter, "aloop=loop=-1:size=2147483647")).toBe(1);
    expect(filter).toContain("atrim=duration=4.000000,asetpts=PTS-STARTPTS,volume=0.25");
    expect(filter).toContain(
      `[${sfx.streamLabel}]asetpts=PTS-STARTPTS,aresample=48000:async=0:first_pts=0`,
    );
    expect(filter).toContain(
      "atrim=duration=0.200000,asetpts=PTS-STARTPTS,volume=1.2,adelay=delays=750:all=1",
    );
    expect(filter).toContain(
      `[${voice.streamLabel}]asetpts=PTS-STARTPTS,aresample=48000:async=0:first_pts=0`,
    );
    expect(filter).toContain(
      "atrim=duration=1.000000,asetpts=PTS-STARTPTS,volume=0.8,adelay=delays=1000:all=1",
    );
  });

  it("aligns source crossfade ramps to the visual transition", () => {
    const plan = mixedPlan();
    const filter = plan.filterComplex ?? "";
    const left = entry(plan, "source-a").label;
    const right = entry(plan, "source-b").label;

    expect(plan.crossfades).toEqual([
      {
        transitionId: "transition-a-b",
        fromSourceId: "source-a",
        toSourceId: "source-b",
        startMs: 1_500,
        durationMs: 500,
      },
    ]);
    expect(filter).toContain(
      `[${left}_content]afade=t=out:st=1.500000:d=0.500000:curve=tri,atrim=duration=4.000000[${left}_track]`,
    );
    expect(filter).toContain(
      `[${right}_content]afade=t=in:st=0:d=0.500000:curve=tri,adelay=delays=1500:all=1,atrim=duration=4.000000[${right}_track]`,
    );
  });

  it("ducks source and BGM from voiceover without ducking SFX", () => {
    const plan = mixedPlan();
    const filter = plan.filterComplex ?? "";

    expect(plan.ducking).toEqual({
      targetReductionDb: -12,
      attackMs: 80,
      releaseMs: 250,
      carriers: ["source", "bgm"],
    });
    expect(EXPORT_AUDIO_DUCKING.targetReductionDb).toBe(-12);
    expect(filter).toContain(
      "[voiceover_bus]asplit=3[voiceover_final][voiceover_sc_source][voiceover_sc_bgm]",
    );
    expect(occurrences(filter, "sidechaincompress=")).toBe(2);
    expect(occurrences(filter, "threshold=0.063096:ratio=2:attack=80:release=250")).toBe(2);
    expect(filter).toContain("[source_ducked]");
    expect(filter).toContain("[bgm_ducked]");
    expect(filter).toContain("[sfx_bus]");
    expect(filter).not.toContain("[sfx_bus][voiceover_sc_");
  });

  it("normalizes sample rate/channel layout and limits the master to -1 dBFS", () => {
    const plan = mixedPlan();
    const filter = plan.filterComplex ?? "";

    expect(EXPORT_AUDIO_LIMIT_DBFS).toBe(-1);
    expect(plan).toMatchObject({ channels: 2, channelLayout: "stereo", sampleRateHz: 48_000 });
    expect(filter).toContain("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo");
    expect(filter).toContain("alimiter=limit=0.891251:attack=5:release=50:level=disabled");
    expect(plan.mapArgs).toEqual(["-map", "[audio_master]"]);
    expect(plan.encoderArgs).toEqual(["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]);
  });

  it("uses generated silence for source files without an audio stream", () => {
    const plan = mixedPlan(graph(), { "source-a": false, "source-b": true });
    const missing = entry(plan, "source-a");

    expect(missing).toMatchObject({ available: false, included: false, inputIndex: null });
    expect(plan.inputArgs).not.toContain("/fixtures/a.mp4");
    expect(plan.filterComplex).toContain(
      `anullsrc=r=48000:cl=stereo,atrim=duration=2.000000,asetpts=PTS-STARTPTS[${missing.label}_content]`,
    );
  });

  it("does not open a source whose time map contains only holds", () => {
    const value = graph();
    value.duration_ms = 1_000;
    value.video = [
      source("held-source", "held-video", "/fixtures/held.mp4", 0, 1_000, {
        version: 1,
        segments: [
          {
            kind: "hold",
            sourcePtsUs: 250_000,
            timelineStartMs: 0,
            timelineEndMs: 1_000,
            reason: "user",
          },
        ],
      }),
    ];
    value.audio = [];
    const plan = mixedPlan(value, { "held-source": true });
    const held = entry(plan, "held-source");

    expect(held).toMatchObject({ available: true, included: false, inputIndex: null });
    expect(plan.inputArgs).toEqual([]);
    expect(plan.filterComplex).toContain(
      `anullsrc=r=48000:cl=stereo,atrim=duration=1.000000,asetpts=PTS-STARTPTS[${held.label}_content]`,
    );
  });

  it("emits AAC for MP4, Opus for WebM, and an informational no-audio GIF plan", () => {
    const value = graph();
    const webm = buildExportAudioPlan({
      graph: value,
      output: { format: "webm", bitrateKbps: 160, channels: 1, sampleRateHz: 44_100 },
      sourceAudio: { "source-a": true, "source-b": true },
    });
    const gif = buildExportAudioPlan({
      graph: value,
      output: { format: "gif" },
      sourceAudio: {},
    });

    expect(webm).toMatchObject({ kind: "mixed", codec: "opus", channelLayout: "mono" });
    expect(webm.encoderArgs).toContain("libopus");
    expect(gif).toMatchObject({
      kind: "none",
      codec: null,
      inputArgs: [],
      filterComplex: null,
      mapArgs: ["-an"],
    });
    expect(gif.registry).toHaveLength(5);
    expect(gif.registry.every((registration) => registration.inputIndex === null)).toBe(true);
    expect(gif.diagnostics).toEqual([
      expect.objectContaining({ code: "export.audio-omitted-for-gif", severity: "info" }),
    ]);
  });

  it("fails planning when a source has not been probed instead of guessing", () => {
    const plan = buildExportAudioPlan({
      graph: graph(),
      output: { format: "mp4", bitrateKbps: 160, channels: 2, sampleRateHz: 48_000 },
      sourceAudio: { "source-a": true },
    });

    expect(plan.kind).toBe("invalid");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "export.audio-source-state-missing",
        clip_id: "video-b",
        severity: "error",
      }),
    );
    expect(plan.inputArgs).toEqual([]);
  });
});

async function makeTempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-export-audio-"));
  tempDirs.push(directory);
  return directory;
}

async function createMarkerFixture(filePath: string): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary is unavailable");
  await execFileAsync(ffmpegPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono:d=1.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000:duration=0.04",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=2000:sample_rate=48000:duration=0.04",
    "-filter_complex",
    "[1:a]adelay=delays=200:all=1[marker1];[2:a]adelay=delays=1200:all=1[marker2];[0:a][marker1][marker2]amix=inputs=3:duration=first:normalize=0[out]",
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    filePath,
  ]);
}

async function createToneFixture(
  filePath: string,
  frequency: number,
  durationSeconds: number,
): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary is unavailable");
  await execFileAsync(ffmpegPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:sample_rate=48000:duration=${durationSeconds}`,
    "-c:a",
    "pcm_s16le",
    filePath,
  ]);
}

async function renderPcmPlan(
  plan: Extract<ExportAudioPlan, { kind: "mixed" }>,
  outputPath: string,
): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary is unavailable");
  await execFileAsync(
    ffmpegPath,
    [
      "-y",
      ...plan.inputArgs,
      "-filter_complex",
      plan.filterComplex,
      ...plan.mapArgs,
      "-c:a",
      "pcm_s16le",
      "-ar",
      String(plan.sampleRateHz),
      "-ac",
      String(plan.channels),
      ...plan.outputArgs,
      outputPath,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
  );
  const decoded = spawnSync(
    ffmpegPath,
    [
      "-v",
      "error",
      "-i",
      outputPath,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      String(plan.sampleRateHz),
      "pipe:1",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (decoded.status !== 0) {
    throw new Error(`failed to decode audio fixture: ${String(decoded.stderr)}`);
  }
  return decoded.stdout;
}

function activeRegionStarts(pcm: Buffer, sampleRateHz: number): number[] {
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const windowSamples = Math.round(sampleRateHz * 0.005);
  const active: boolean[] = [];
  for (let start = 0; start < samples.length; start += windowSamples) {
    let sumSquares = 0;
    const end = Math.min(samples.length, start + windowSamples);
    for (let index = start; index < end; index += 1) {
      const sample = samples[index] ?? 0;
      sumSquares += sample * sample;
    }
    active.push(Math.sqrt(sumSquares / Math.max(1, end - start)) > 0.01);
  }
  const starts: number[] = [];
  for (let index = 0; index < active.length; index += 1) {
    if (active[index] && !active[index - 1]) starts.push((index * windowSamples) / sampleRateHz);
  }
  return starts;
}

describe("export audio FFmpeg integration", () => {
  it.skipIf(!ffmpegPath)(
    "executes the complete crossfade, loop, delayed sound, dual-duck, and limiter graph",
    async () => {
      const directory = await makeTempDir();
      const paths = {
        sourceA: path.join(directory, "source-a.wav"),
        sourceB: path.join(directory, "source-b.wav"),
        bgm: path.join(directory, "bgm.wav"),
        sfx: path.join(directory, "sfx.wav"),
        voice: path.join(directory, "voice.wav"),
      };
      await Promise.all([
        createToneFixture(paths.sourceA, 220, 2),
        createToneFixture(paths.sourceB, 330, 2),
        createToneFixture(paths.bgm, 440, 0.2),
        createToneFixture(paths.sfx, 880, 0.1),
        createToneFixture(paths.voice, 1_000, 0.5),
      ]);
      const value = graph();
      const firstSource = value.video.find(
        (node): node is Extract<ExportVideoNode, { type: "source" }> =>
          node.type === "source" && node.id === "source-a",
      );
      const secondSource = value.video.find(
        (node): node is Extract<ExportVideoNode, { type: "source" }> =>
          node.type === "source" && node.id === "source-b",
      );
      if (!firstSource || !secondSource) throw new Error("missing source fixtures");
      firstSource.path = paths.sourceA;
      firstSource.source_time_map = undefined;
      secondSource.path = paths.sourceB;
      const pathById = new Map([
        ["sound-bgm", paths.bgm],
        ["sound-sfx", paths.sfx],
        ["sound-voice", paths.voice],
      ]);
      for (const sound of value.audio) sound.path = pathById.get(sound.id) ?? sound.path;
      const plan = buildExportAudioPlan({
        graph: value,
        output: { format: "mp4", bitrateKbps: 160, channels: 1, sampleRateHz: 48_000 },
        sourceAudio: { "source-a": true, "source-b": true },
        firstInputIndex: 0,
      });
      if (plan.kind !== "mixed") throw new Error(JSON.stringify(plan.diagnostics));

      const pcm = await renderPcmPlan(plan, path.join(directory, "full-mix.wav"));
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      const tailStart = Math.round(plan.sampleRateHz * 3.8);
      let tailEnergy = 0;
      for (let index = tailStart; index < samples.length; index += 1) {
        tailEnergy += Math.abs(samples[index] ?? 0);
      }

      expect(pcm.byteLength / 4 / plan.sampleRateHz).toBeCloseTo(4, 2);
      expect(peak).toBeLessThanOrEqual(0.895);
      expect(tailEnergy / Math.max(1, samples.length - tailStart)).toBeGreaterThan(0.005);
    },
    20_000,
  );

  it.skipIf(!ffmpegPath)(
    "keeps mapped synthetic marker timing within 20 ms and preserves hold silence",
    async () => {
      const directory = await makeTempDir();
      const inputPath = path.join(directory, "markers.wav");
      const outputPath = path.join(directory, "mapped.wav");
      await createMarkerFixture(inputPath);
      const markerGraph: ExportCompositionGraphV4 = {
        schema_version: 4,
        output_width: 64,
        output_height: 64,
        output_fps: 30,
        duration_ms: 1_400,
        video: [
          source("marker-source", "marker-video", inputPath, 250, 1_000, {
            version: 1,
            segments: [
              {
                kind: "media",
                sourceStartUs: 100_000,
                sourceEndUs: 500_000,
                timelineStartMs: 0,
                timelineEndMs: 400,
              },
              {
                kind: "hold",
                sourcePtsUs: 500_000,
                timelineStartMs: 400,
                timelineEndMs: 600,
                reason: "cursor-motion",
              },
              {
                kind: "media",
                sourceStartUs: 1_000_000,
                sourceEndUs: 1_400_000,
                timelineStartMs: 600,
                timelineEndMs: 1_000,
              },
            ],
          }),
        ],
        audio: [],
      };
      const plan = buildExportAudioPlan({
        graph: markerGraph,
        output: { format: "mp4", bitrateKbps: 160, channels: 1, sampleRateHz: 48_000 },
        sourceAudio: { "marker-source": true },
        firstInputIndex: 0,
      });
      if (plan.kind !== "mixed") throw new Error(JSON.stringify(plan.diagnostics));

      const pcm = await renderPcmPlan(plan, outputPath);
      const starts = activeRegionStarts(pcm, plan.sampleRateHz);
      expect(starts).toHaveLength(2);
      expect(Math.abs((starts[0] ?? 0) - 0.35)).toBeLessThanOrEqual(0.02);
      expect(Math.abs((starts[1] ?? 0) - 1.05)).toBeLessThanOrEqual(0.02);
      expect(pcm.byteLength / 4 / plan.sampleRateHz).toBeCloseTo(1.4, 2);
    },
    20_000,
  );

  it.skipIf(!ffmpegPath)(
    "renders the exact duration from silence when the source has no audio stream",
    async () => {
      const directory = await makeTempDir();
      const outputPath = path.join(directory, "silence.wav");
      const silentGraph: ExportCompositionGraphV4 = {
        schema_version: 4,
        output_width: 64,
        output_height: 64,
        output_fps: 30,
        duration_ms: 500,
        video: [source("silent-source", "silent-video", "/not-opened/video.mp4", 0, 500)],
        audio: [],
      };
      const plan = buildExportAudioPlan({
        graph: silentGraph,
        output: { format: "mp4", bitrateKbps: 160, channels: 1, sampleRateHz: 48_000 },
        sourceAudio: { "silent-source": false },
        firstInputIndex: 0,
      });
      if (plan.kind !== "mixed") throw new Error(JSON.stringify(plan.diagnostics));

      const pcm = await renderPcmPlan(plan, outputPath);
      expect(plan.inputArgs).toEqual([]);
      expect(pcm.byteLength / 4 / plan.sampleRateHz).toBeCloseTo(0.5, 2);
      expect(activeRegionStarts(pcm, plan.sampleRateHz)).toEqual([]);
    },
    20_000,
  );
});

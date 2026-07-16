import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ExportCompositionGraphV4 } from "@storycapture/shared-types";

import {
  createAllEffectsExportGraph,
  type ExportE2eFixturePaths,
} from "../../src/features/post-production/export-compositor/export-e2e-fixture";
import { exportFfmpegPath } from "./export-binaries";
import { createExportCompositorHost } from "./export-compositor-host";
import {
  findPixelBounds,
  frameSsim,
  maximumBoundsDelta,
  maximumColorDelta,
  sampleBgra,
} from "./export-quality-gate";
import {
  type VerifiedExportArtifact,
  verifyExportArtifact,
} from "./legacy/export-artifact-verification";
import { exportRun, renderCancel, renderListActive } from "./legacy/export-render";
import type { ExportOutput, RenderJob } from "./legacy/shared";

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const SAMPLE_FRAME_INDICES = [6, 25, 42] as const;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const QUALITY_WIDTH = 1280;
const QUALITY_HEIGHT = 720;
const QUALITY_FPS = 30;
const QUALITY_DURATION_MS = 1_000;
const QUALITY_FINAL_FRAME = QUALITY_FPS * (QUALITY_DURATION_MS / 1_000) - 1;
const SOFTWARE_HIGH_MINIMUM_SSIM = 0.995;
const HARDWARE_HIGH_MINIMUM_SSIM = 0.985;

const HARDWARE_ENCODER_CANDIDATES = [
  {
    id: "video-toolbox-h264",
    ffmpegName: "h264_videotoolbox",
    preset: "quality",
    platforms: ["darwin"],
  },
  { id: "nvenc-h264", ffmpegName: "h264_nvenc", preset: "p4", platforms: ["win32"] },
  { id: "qsv-h264", ffmpegName: "h264_qsv", preset: "medium", platforms: ["win32"] },
  { id: "amf-h264", ffmpegName: "h264_amf", preset: "balanced", platforms: ["win32"] },
] as const;

type HardwareEncoderCandidate = (typeof HARDWARE_ENCODER_CANDIDATES)[number];

const CAPTURE_MATRIX = [
  { label: "720p30", width: 1280, height: 720, fps: 30, captureDpr: 1 },
  { label: "1080p30", width: 1920, height: 1080, fps: 30, captureDpr: 2 },
  { label: "1080p60", width: 1920, height: 1080, fps: 60, captureDpr: 1 },
  { label: "4k30", width: 3840, height: 2160, fps: 30, captureDpr: 2 },
  { label: "4k60", width: 3840, height: 2160, fps: 60, captureDpr: 2 },
] as const;

export interface ExportEncodedFrameEvidence {
  frameIndex: number;
  rawSha256: string;
  ssim: number;
}

export interface ExportPipelineFormatEvidence {
  format: "mp4" | "webm" | "gif";
  outputPath: string;
  bytes: number;
  status: RenderJob["status"];
  encodedFrames: ExportEncodedFrameEvidence[];
}

export interface ExportPipelineSmokeEvidence {
  graphNodeTypes: string[];
  audioKinds: string[];
  jobs: ExportPipelineFormatEvidence[];
  minimumSsim: number;
  maximumActiveWeight: number;
  independentQuality: {
    referenceGenerator: "ffmpeg-lavfi-source";
    softwareHighFinalFrameSsim: number;
    hardwareHigh:
      | {
          status: "passed";
          encoder: HardwareEncoderCandidate["id"];
          finalFrameSsim: number;
          artifact: VerifiedExportArtifact;
        }
      | { status: "skipped"; reason: string };
    overlayGeometryDeltaPx: number;
    colorSampleDelta: number;
    distinctDecodedFrames: number;
    artifact: VerifiedExportArtifact;
  };
  captureMatrix: Array<{
    label: string;
    width: number;
    height: number;
    fps: number;
    captureDpr: number;
    frameBytes: number;
  }>;
}

async function runFfmpeg(args: string[], captureStdout = false): Promise<Buffer> {
  const binary = exportFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`fixture ffmpeg exited with ${code}: ${stderr}`));
    });
  });
}

async function createVideoFixture(
  outputPath: string,
  color: string,
  toneHz: number,
): Promise<void> {
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=1`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${toneHz}:sample_rate=48000:duration=1`,
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "12",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputPath,
  ]);
}

async function createToneFixture(outputPath: string, toneHz: number, durationSeconds: number) {
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${toneHz}:sample_rate=48000:duration=${durationSeconds}`,
    "-c:a",
    "pcm_s16le",
    outputPath,
  ]);
}

async function createFixtureFiles(root: string): Promise<ExportE2eFixturePaths> {
  await fs.mkdir(root, { recursive: true });
  const paths: ExportE2eFixturePaths = {
    sourceA: path.join(root, "source-a.mp4"),
    sourceB: path.join(root, "source-b.mp4"),
    bgm: path.join(root, "bgm.wav"),
    sfx: path.join(root, "sfx.wav"),
    voiceover: path.join(root, "voiceover.wav"),
    actions: path.join(root, "cursor.actions.json"),
    trajectory: path.join(root, "cursor.trajectory.json"),
    cursorPngSequence: path.join(root, "cursor-frames"),
    backgroundImage: path.join(root, "background.png"),
  };
  await Promise.all([
    createVideoFixture(paths.sourceA, "0x244a72", 330),
    createVideoFixture(paths.sourceB, "0x6b2f45", 440),
    createToneFixture(paths.bgm, 220, 1.6),
    createToneFixture(paths.sfx, 880, 0.26),
    createToneFixture(paths.voiceover, 550, 0.6),
  ]);
  await fs.writeFile(
    paths.actions,
    `${JSON.stringify(
      {
        version: 1,
        recording_path: paths.sourceA,
        viewport: { width: WIDTH, height: HEIGHT },
        capture_rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        fps: FPS,
        frame_count: 48,
        events: [
          {
            step_id: "cta",
            ordinal: 1,
            verb: "click",
            t_start_ms: 180,
            t_action_ms: 300,
            t_end_ms: 480,
            target: {
              kind: "element",
              label: "Call to action",
              center: { x: 112, y: 104 },
              bounds: { x: 80, y: 88, w: 64, h: 32 },
            },
            secondary_target: null,
            pointer: { button: "left", effect: "click" },
          },
          {
            step_id: "result",
            ordinal: 2,
            verb: "click",
            t_start_ms: 900,
            t_action_ms: 1_080,
            t_end_ms: 1_300,
            target: {
              kind: "element",
              label: "Result",
              center: { x: 228, y: 70 },
              bounds: { x: 196, y: 54, w: 64, h: 32 },
            },
            secondary_target: null,
            pointer: { button: "left", effect: "click" },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    paths.trajectory,
    `${JSON.stringify(
      {
        recording_path: paths.sourceA,
        capture_rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
        fps: FPS,
        frame_count: 48,
        frames: [
          { t_ms: 0, x: 80, y: 90, click: false },
          { t_ms: 800, x: 160, y: 100, click: true },
          { t_ms: 1_600, x: 240, y: 70, click: false },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return paths;
}

function mp4Output(): ExportOutput {
  return {
    format: "mp4",
    resolution: "custom",
    output_width: WIDTH,
    output_height: HEIGHT,
    fps: FPS,
    quality: "high",
    encoder_options: {
      container: "mp4",
      codec: "h264",
      rate_control: "crf",
      hw_encoder: "libx264-software",
      quality_value: null,
      encoder_preset: "veryfast",
      keyframe_interval_sec: 1,
      resampling_quality: "high",
      audio: { codec: "aac", bitrate_kbps: 192, channels: 2, sample_rate_hz: 48_000 },
    },
  };
}

function webmOutput(): ExportOutput {
  return {
    format: "webm",
    resolution: "custom",
    output_width: WIDTH,
    output_height: HEIGHT,
    fps: FPS,
    quality: "high",
    encoder_options: {
      container: "webm",
      codec: "h264",
      rate_control: "auto",
      hw_encoder: "libx264-software",
      quality_value: null,
      encoder_preset: "medium",
      keyframe_interval_sec: 1,
      resampling_quality: "high",
      audio: { codec: "opus", bitrate_kbps: 160, channels: 2, sample_rate_hz: 48_000 },
    },
  };
}

function gifOutput(): ExportOutput {
  return {
    format: "gif",
    resolution: "custom",
    output_width: WIDTH,
    output_height: HEIGHT,
    fps: FPS,
    quality: "high",
    encoder_options: null,
  };
}

async function waitForJobs(
  storyId: string,
  jobIds: readonly string[],
): Promise<{ jobs: RenderJob[]; maximumActiveWeight: number }> {
  const pending = new Set(jobIds);
  const latest = new Map<string, RenderJob>();
  const deadline = Date.now() + 150_000;
  let maximumActiveWeight = 0;
  while (pending.size > 0 && Date.now() < deadline) {
    const snapshot = renderListActive(storyId);
    const activeWeight = snapshot
      .filter((job) => job.status !== "queued" && !TERMINAL_STATUSES.has(job.status))
      .reduce(
        (weight, job) =>
          weight + ((job.output_width ?? 0) * (job.output_height ?? 0) <= 2560 * 1440 ? 1 : 2),
        0,
      );
    maximumActiveWeight = Math.max(maximumActiveWeight, activeWeight);
    if (activeWeight > 2) {
      throw new Error(`export scheduler used ${activeWeight} units; capacity is 2`);
    }
    for (const job of snapshot) {
      if (!pending.has(job.id)) continue;
      latest.set(job.id, { ...job });
      if (TERMINAL_STATUSES.has(job.status)) pending.delete(job.id);
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pending.size > 0) {
    for (const id of pending) renderCancel(id);
    throw new Error(`export E2E timed out waiting for jobs: ${[...pending].join(", ")}`);
  }
  const jobs = jobIds.map((id) => latest.get(id)).filter((job): job is RenderJob => Boolean(job));
  const failures = jobs.filter((job) => job.status !== "completed");
  if (failures.length > 0) {
    throw new Error(
      `export E2E jobs failed: ${failures
        .map((job) => `${job.format}:${job.status}:${job.error ?? "unknown error"}`)
        .join("; ")}`,
    );
  }
  return { jobs, maximumActiveWeight };
}

async function renderCanonicalGoldens(
  graph: ExportCompositionGraphV4,
): Promise<Map<number, Buffer>> {
  const host = createExportCompositorHost({
    graph,
    outputWidth: graph.output_width,
    outputHeight: graph.output_height,
    fps: graph.output_fps,
    durationMs: graph.duration_ms,
  });
  try {
    await host.start();
    const frames = new Map<number, Buffer>();
    for (const frameIndex of SAMPLE_FRAME_INDICES) {
      frames.set(frameIndex, await host.renderFrame((frameIndex / graph.output_fps) * 1_000));
    }
    return frames;
  } finally {
    await host.dispose();
  }
}

async function decodeFrame(
  outputPath: string,
  frameIndex: number,
  width = WIDTH,
  height = HEIGHT,
): Promise<Buffer> {
  const frame = await runFfmpeg(
    [
      "-v",
      "error",
      "-i",
      outputPath,
      "-vf",
      `select=eq(n\\,${frameIndex})`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "pipe:1",
    ],
    true,
  );
  const expectedBytes = width * height * 4;
  if (frame.byteLength !== expectedBytes) {
    throw new Error(
      `decoded ${path.basename(outputPath)} frame ${frameIndex} has ${frame.byteLength} bytes; expected ${expectedBytes}`,
    );
  }
  return frame;
}

function escapedFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function packagedFixtureFontPath(): string {
  return path.join(process.resourcesPath, "assets", "fonts", "Geist-Regular.ttf");
}

async function createIndependentQualityFixture(root: string): Promise<{
  sourcePath: string;
  audioPath: string;
}> {
  await fs.mkdir(root, { recursive: true });
  const sourcePath = path.join(root, "independent-quality-source.mp4");
  const audioPath = path.join(root, "independent-quality-audio.wav");
  const markerX = Math.round(QUALITY_WIDTH * 0.12);
  const markerY = Math.round(QUALITY_HEIGHT * 0.55);
  const fontPath = packagedFixtureFontPath();
  const videoFilter = [
    "drawbox=x=32:y=32:w=72:h=72:color=0x2455a4:t=fill",
    "drawbox=x=104:y=32:w=72:h=72:color=0x2f855a:t=fill",
    "drawbox=x=176:y=32:w=72:h=72:color=0x2b6f78:t=fill",
    "drawbox=x=1:y=1:w=iw-2:h=ih-2:color=white:t=1",
    `drawbox=x=${markerX}:y=${markerY}:w=64:h=32:color=0xff2038:t=fill`,
    `drawbox=x=${markerX - 1}:y=${markerY - 1}:w=66:h=34:color=white:t=1`,
    "drawbox=x=iw*0.72:y=ih*0.62:w=3:h=44:color=0xffd74a:t=fill",
    "drawbox=x=iw*0.72-20:y=ih*0.62+20:w=44:h=3:color=0xffd74a:t=fill",
    `drawtext=fontfile='${escapedFilterPath(fontPath)}':text='StoryCapture QUALITY 1px':x=${Math.round(QUALITY_WIDTH * 0.08)}:y=${Math.round(QUALITY_HEIGHT * 0.12)}:fontsize=42:fontcolor=white:borderw=1:bordercolor=black`,
    `drawtext=fontfile='${escapedFilterPath(fontPath)}':text='CURSOR + CLICK':x=${Math.round(QUALITY_WIDTH * 0.66)}:y=${Math.round(QUALITY_HEIGHT * 0.72)}:fontsize=26:fontcolor=0xffd74a`,
    `drawtext=fontfile='${escapedFilterPath(fontPath)}':text='FRAME %{n}':x=${Math.round(QUALITY_WIDTH * 0.82)}:y=${Math.round(QUALITY_HEIGHT * 0.9)}:fontsize=20:fontcolor=white`,
  ].join(",");
  await Promise.all([
    runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0x303030:size=${QUALITY_WIDTH}x${QUALITY_HEIGHT}:rate=${QUALITY_FPS}:duration=${QUALITY_DURATION_MS / 1_000}`,
      "-vf",
      videoFilter,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-an",
      sourcePath,
    ]),
    createToneFixture(audioPath, 997, QUALITY_DURATION_MS / 1_000),
  ]);
  return { sourcePath, audioPath };
}

function independentQualityGraph(sourcePath: string, audioPath: string): ExportCompositionGraphV4 {
  return {
    schema_version: 4,
    output_width: QUALITY_WIDTH,
    output_height: QUALITY_HEIGHT,
    output_fps: QUALITY_FPS,
    duration_ms: QUALITY_DURATION_MS,
    video: [
      {
        type: "source",
        id: "independent-source",
        clip_id: "independent-source-clip",
        path: sourcePath,
        pts_offset_ms: 0,
        timeline_start_ms: 0,
        duration_ms: QUALITY_DURATION_MS,
        source_width: QUALITY_WIDTH,
        source_height: QUALITY_HEIGHT,
      },
    ],
    audio: [
      {
        type: "sound",
        id: "deterministic-voiceover",
        clip_id: "deterministic-voiceover-clip",
        kind: "voiceover",
        path: audioPath,
        t_start_ms: 0,
        duration_ms: QUALITY_DURATION_MS,
        gain: 0.8,
        source_binding: {
          kind: "story-voiceover",
          stepId: "independent-quality",
          ordinal: 1,
        },
      },
    ],
  };
}

function qualityMp4Output(): ExportOutput {
  return {
    ...mp4Output(),
    output_width: QUALITY_WIDTH,
    output_height: QUALITY_HEIGHT,
    fps: QUALITY_FPS,
  };
}

function hardwareQualityMp4Output(candidate: HardwareEncoderCandidate): ExportOutput {
  const output = qualityMp4Output();
  return {
    ...output,
    encoder_options: {
      ...output.encoder_options,
      rate_control: "vbr",
      hw_encoder: candidate.id,
      quality_value: null,
      encoder_preset: candidate.preset,
    },
  };
}

async function availableHardwareCandidates(): Promise<HardwareEncoderCandidate[]> {
  const encoderList = (await runFfmpeg(["-hide_banner", "-encoders"], true)).toString("utf8");
  return HARDWARE_ENCODER_CANDIDATES.filter(
    (candidate) =>
      candidate.platforms.some((platform) => platform === process.platform) &&
      new RegExp(`\\b${candidate.ffmpegName}\\b`).test(encoderList),
  );
}

async function runHardwareHighQualityGate(
  graph: ExportCompositionGraphV4,
  reference: Buffer,
  outputRoot: string,
): Promise<ExportPipelineSmokeEvidence["independentQuality"]["hardwareHigh"]> {
  const candidates = await availableHardwareCandidates();
  if (candidates.length === 0) {
    return {
      status: "skipped",
      reason: `no bundled hardware H.264 encoder for ${process.platform}`,
    };
  }

  const unavailableReasons: string[] = [];
  for (const candidate of candidates) {
    let outputPath: string;
    try {
      const storyId = `export-e2e-hardware-quality-${candidate.id}`;
      const run = await exportRun({
        story_id: storyId,
        graph_json: JSON.stringify(graph),
        outputs: [hardwareQualityMp4Output(candidate)],
        priority: 1,
        output_folder: outputRoot,
        base_name: `hardware-quality-${candidate.id}`,
        preset_id: null,
        ai_disclosure: { contains_ai_voiceover: true, embed_xmp: false },
      });
      const { jobs } = await waitForJobs(storyId, run.job_ids);
      outputPath = jobs[0]?.output_path ?? "";
      if (!outputPath) throw new Error("hardware quality export completed without an output path");
    } catch (error) {
      unavailableReasons.push(
        `${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const actual = await decodeFrame(
      outputPath,
      QUALITY_FINAL_FRAME,
      QUALITY_WIDTH,
      QUALITY_HEIGHT,
    );
    const finalFrameSsim = frameSsim(reference, actual, QUALITY_WIDTH, QUALITY_HEIGHT);
    if (finalFrameSsim < HARDWARE_HIGH_MINIMUM_SSIM) {
      throw new Error(
        `hardware High ${candidate.id} SSIM ${finalFrameSsim.toFixed(6)} is below ${HARDWARE_HIGH_MINIMUM_SSIM}`,
      );
    }
    const artifact = await verifyExportArtifact(outputPath, {
      format: "mp4",
      width: QUALITY_WIDTH,
      height: QUALITY_HEIGHT,
      fps: QUALITY_FPS,
      durationMs: QUALITY_DURATION_MS,
      expectAudio: true,
      expectXmp: false,
    });
    return { status: "passed", encoder: candidate.id, finalFrameSsim, artifact };
  }
  return {
    status: "skipped",
    reason: `bundled hardware encoders were unavailable at runtime (${unavailableReasons.join("; ")})`,
  };
}

async function runIndependentQualityGate(
  sourcePath: string,
  audioPath: string,
  outputRoot: string,
): Promise<ExportPipelineSmokeEvidence["independentQuality"]> {
  const graph = independentQualityGraph(sourcePath, audioPath);
  const storyId = "export-e2e-independent-quality";
  const run = await exportRun({
    story_id: storyId,
    graph_json: JSON.stringify(graph),
    outputs: [qualityMp4Output()],
    priority: 1,
    output_folder: outputRoot,
    base_name: "independent-quality",
    preset_id: null,
    ai_disclosure: { contains_ai_voiceover: true, embed_xmp: true },
  });
  const { jobs } = await waitForJobs(storyId, run.job_ids);
  const outputPath = jobs[0]?.output_path;
  if (!outputPath) throw new Error("independent quality export completed without an output path");

  const [reference, actual] = await Promise.all([
    decodeFrame(sourcePath, QUALITY_FINAL_FRAME, QUALITY_WIDTH, QUALITY_HEIGHT),
    decodeFrame(outputPath, QUALITY_FINAL_FRAME, QUALITY_WIDTH, QUALITY_HEIGHT),
  ]);
  const softwareHighFinalFrameSsim = frameSsim(reference, actual, QUALITY_WIDTH, QUALITY_HEIGHT);
  if (softwareHighFinalFrameSsim < SOFTWARE_HIGH_MINIMUM_SSIM) {
    const diagnosticPoint = {
      x: Math.round(QUALITY_WIDTH * 0.5),
      y: Math.round(QUALITY_HEIGHT * 0.5),
    };
    throw new Error(
      `software High independent SSIM ${softwareHighFinalFrameSsim.toFixed(6)} is below ${SOFTWARE_HIGH_MINIMUM_SSIM}; center=${JSON.stringify(
        {
          reference: sampleBgra(
            reference,
            QUALITY_WIDTH,
            QUALITY_HEIGHT,
            diagnosticPoint.x,
            diagnosticPoint.y,
          ),
          actual: sampleBgra(
            actual,
            QUALITY_WIDTH,
            QUALITY_HEIGHT,
            diagnosticPoint.x,
            diagnosticPoint.y,
          ),
        },
      )}`,
    );
  }

  const markerMatches = ({ red, green, blue }: { red: number; green: number; blue: number }) =>
    red > 180 && red > green * 2 && red > blue * 2;
  const referenceBounds = findPixelBounds(reference, QUALITY_WIDTH, QUALITY_HEIGHT, markerMatches);
  const actualBounds = findPixelBounds(actual, QUALITY_WIDTH, QUALITY_HEIGHT, markerMatches);
  if (!referenceBounds || !actualBounds)
    throw new Error("quality fixture red overlay was not found");
  const expectedBounds = {
    left: Math.round(QUALITY_WIDTH * 0.12),
    top: Math.round(QUALITY_HEIGHT * 0.55),
    right: Math.round(QUALITY_WIDTH * 0.12) + 63,
    bottom: Math.round(QUALITY_HEIGHT * 0.55) + 31,
  };
  const overlayGeometryDeltaPx = Math.max(
    maximumBoundsDelta(expectedBounds, referenceBounds),
    maximumBoundsDelta(referenceBounds, actualBounds),
  );
  if (overlayGeometryDeltaPx > 1) {
    throw new Error(`independent overlay geometry differs by ${overlayGeometryDeltaPx}px`);
  }

  const sampleX = expectedBounds.left + 32;
  const sampleY = expectedBounds.top + 16;
  const colorSampleDelta = maximumColorDelta(
    sampleBgra(reference, QUALITY_WIDTH, QUALITY_HEIGHT, sampleX, sampleY),
    sampleBgra(actual, QUALITY_WIDTH, QUALITY_HEIGHT, sampleX, sampleY),
  );
  if (colorSampleDelta > 24) {
    throw new Error(`independent color sample differs by ${colorSampleDelta} levels`);
  }

  const decodedHashes = new Set<string>();
  for (const frameIndex of [0, Math.floor(QUALITY_FINAL_FRAME / 2), QUALITY_FINAL_FRAME]) {
    const frame = await decodeFrame(outputPath, frameIndex, QUALITY_WIDTH, QUALITY_HEIGHT);
    decodedHashes.add(createHash("sha256").update(frame).digest("hex"));
  }
  if (decodedHashes.size < 2) throw new Error("independent export decoded as frozen frames");

  const artifact = await verifyExportArtifact(outputPath, {
    format: "mp4",
    width: QUALITY_WIDTH,
    height: QUALITY_HEIGHT,
    fps: QUALITY_FPS,
    durationMs: QUALITY_DURATION_MS,
    expectAudio: true,
    expectXmp: true,
  });
  const hardwareHigh = await runHardwareHighQualityGate(graph, reference, outputRoot);
  return {
    referenceGenerator: "ffmpeg-lavfi-source",
    softwareHighFinalFrameSsim,
    hardwareHigh,
    overlayGeometryDeltaPx,
    colorSampleDelta,
    distinctDecodedFrames: decodedHashes.size,
    artifact,
  };
}

async function runCaptureMatrix(
  sourcePath: string,
  audioPath: string,
): Promise<ExportPipelineSmokeEvidence["captureMatrix"]> {
  const evidence: ExportPipelineSmokeEvidence["captureMatrix"] = [];
  for (const fixture of CAPTURE_MATRIX) {
    const graph = {
      ...independentQualityGraph(sourcePath, audioPath),
      output_width: fixture.width,
      output_height: fixture.height,
      output_fps: fixture.fps,
      audio: [],
    } satisfies ExportCompositionGraphV4;
    const host = createExportCompositorHost(
      {
        graph,
        outputWidth: fixture.width,
        outputHeight: fixture.height,
        fps: fixture.fps,
        durationMs: QUALITY_DURATION_MS,
      },
      { captureScaleFactor: fixture.captureDpr },
    );
    try {
      await host.start();
      const frame = await host.renderFrame(0);
      const expectedBytes = fixture.width * fixture.height * 4;
      if (frame.byteLength !== expectedBytes) {
        throw new Error(
          `${fixture.label} captured ${frame.byteLength} bytes; expected ${expectedBytes}`,
        );
      }
      evidence.push({
        label: fixture.label,
        width: fixture.width,
        height: fixture.height,
        fps: fixture.fps,
        captureDpr: fixture.captureDpr,
        frameBytes: frame.byteLength,
      });
    } finally {
      await host.dispose();
    }
  }
  return evidence;
}

export async function runExportPipelineSmoke(root: string): Promise<ExportPipelineSmokeEvidence> {
  const fixtureRoot = path.join(root, "fixture");
  const outputRoot = path.join(root, "outputs");
  const paths = await createFixtureFiles(fixtureRoot);
  const graph = createAllEffectsExportGraph(paths);
  const storyId = "export-e2e-all-effects";
  const run = await exportRun({
    story_id: storyId,
    graph_json: JSON.stringify(graph),
    outputs: [mp4Output(), webmOutput(), gifOutput()],
    priority: 0,
    output_folder: outputRoot,
    base_name: "all-effects",
    preset_id: null,
    ai_disclosure: { contains_ai_voiceover: false, embed_xmp: false },
  });
  const { jobs, maximumActiveWeight } = await waitForJobs(storyId, run.job_ids);
  const rawGoldens = await renderCanonicalGoldens(graph);
  const evidence: ExportPipelineFormatEvidence[] = [];
  let minimumSsim = 1;

  for (const job of jobs) {
    if (!job.output_path) throw new Error(`${job.format} job completed without an output path`);
    const stat = await fs.stat(job.output_path);
    const encodedFrames: ExportEncodedFrameEvidence[] = [];
    if (job.format === "mp4" || job.format === "webm") {
      for (const frameIndex of SAMPLE_FRAME_INDICES) {
        const raw = rawGoldens.get(frameIndex);
        if (!raw) throw new Error(`missing canonical golden for frame ${frameIndex}`);
        const ssim = frameSsim(raw, await decodeFrame(job.output_path, frameIndex), WIDTH, HEIGHT);
        minimumSsim = Math.min(minimumSsim, ssim);
        encodedFrames.push({
          frameIndex,
          rawSha256: createHash("sha256").update(raw).digest("hex"),
          ssim,
        });
      }
    }
    evidence.push({
      format: job.format as "mp4" | "webm" | "gif",
      outputPath: job.output_path,
      bytes: stat.size,
      status: job.status,
      encodedFrames,
    });
  }
  if (minimumSsim < 0.99) {
    throw new Error(`encoded frame SSIM ${minimumSsim.toFixed(6)} is below 0.99`);
  }
  const independentPaths = await createIndependentQualityFixture(
    path.join(fixtureRoot, "independent-quality"),
  );
  const independentQuality = await runIndependentQualityGate(
    independentPaths.sourcePath,
    independentPaths.audioPath,
    outputRoot,
  );
  const captureMatrix = await runCaptureMatrix(
    independentPaths.sourcePath,
    independentPaths.audioPath,
  );
  return {
    graphNodeTypes: [...new Set(graph.video.map((node) => node.type))].sort(),
    audioKinds: [...new Set(graph.audio.map((node) => node.kind))].sort(),
    jobs: evidence,
    minimumSsim,
    maximumActiveWeight,
    independentQuality,
    captureMatrix,
  };
}

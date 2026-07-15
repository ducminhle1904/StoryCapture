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
import { exportRun, renderCancel, renderListActive } from "./legacy/export-render";
import type { ExportOutput, RenderJob } from "./legacy/shared";

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const FRAME_BYTES = WIDTH * HEIGHT * 4;
const SAMPLE_FRAME_INDICES = [6, 25, 42] as const;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
      quality_value: 0,
      x264_preset: "veryfast",
      keyframe_interval_sec: 1,
      downscale_algo: "lanczos",
      audio: { codec: "aac", bitrate_kbps: 160, channels: 2, sample_rate_hz: 48_000 },
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
      x264_preset: "medium",
      keyframe_interval_sec: 1,
      downscale_algo: "lanczos",
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

async function waitForJobs(storyId: string, jobIds: readonly string[]): Promise<RenderJob[]> {
  const pending = new Set(jobIds);
  const latest = new Map<string, RenderJob>();
  const deadline = Date.now() + 150_000;
  while (pending.size > 0 && Date.now() < deadline) {
    for (const job of renderListActive(storyId)) {
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
  return jobs;
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

async function decodeFrame(outputPath: string, frameIndex: number): Promise<Buffer> {
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
  if (frame.byteLength !== FRAME_BYTES) {
    throw new Error(
      `decoded ${path.basename(outputPath)} frame ${frameIndex} has ${frame.byteLength} bytes; expected ${FRAME_BYTES}`,
    );
  }
  return frame;
}

function luma(frame: Buffer, pixel: number): number {
  const offset = pixel * 4;
  return 0.0722 * frame[offset] + 0.7152 * frame[offset + 1] + 0.2126 * frame[offset + 2];
}

function frameSsim(reference: Buffer, actual: Buffer): number {
  if (reference.byteLength !== FRAME_BYTES || actual.byteLength !== FRAME_BYTES) {
    throw new Error("SSIM requires full-size BGRA frames");
  }
  const blockSize = 8;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  let blocks = 0;
  for (let y = 0; y < HEIGHT; y += blockSize) {
    for (let x = 0; x < WIDTH; x += blockSize) {
      let count = 0;
      let sumReference = 0;
      let sumActual = 0;
      let sumReferenceSquared = 0;
      let sumActualSquared = 0;
      let sumProduct = 0;
      for (let dy = 0; dy < blockSize && y + dy < HEIGHT; dy += 1) {
        for (let dx = 0; dx < blockSize && x + dx < WIDTH; dx += 1) {
          const pixel = (y + dy) * WIDTH + x + dx;
          const referenceValue = luma(reference, pixel);
          const actualValue = luma(actual, pixel);
          count += 1;
          sumReference += referenceValue;
          sumActual += actualValue;
          sumReferenceSquared += referenceValue * referenceValue;
          sumActualSquared += actualValue * actualValue;
          sumProduct += referenceValue * actualValue;
        }
      }
      const meanReference = sumReference / count;
      const meanActual = sumActual / count;
      const varianceReference = Math.max(0, sumReferenceSquared / count - meanReference ** 2);
      const varianceActual = Math.max(0, sumActualSquared / count - meanActual ** 2);
      const covariance = sumProduct / count - meanReference * meanActual;
      total +=
        ((2 * meanReference * meanActual + c1) * (2 * covariance + c2)) /
        ((meanReference ** 2 + meanActual ** 2 + c1) * (varianceReference + varianceActual + c2));
      blocks += 1;
    }
  }
  return total / blocks;
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
  });
  const jobs = await waitForJobs(storyId, run.job_ids);
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
        const ssim = frameSsim(raw, await decodeFrame(job.output_path, frameIndex));
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
  return {
    graphNodeTypes: [...new Set(graph.video.map((node) => node.type))].sort(),
    audioKinds: [...new Set(graph.audio.map((node) => node.kind))].sort(),
    jobs: evidence,
    minimumSsim,
  };
}

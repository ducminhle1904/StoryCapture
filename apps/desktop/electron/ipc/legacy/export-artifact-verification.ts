import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { exportFfmpegPath, exportFfprobePath } from "../export-binaries";

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeDocument {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export interface ExportArtifactExpectation {
  format: "mp4" | "webm" | "gif";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  expectAudio: boolean;
}

export interface VerifiedExportArtifact {
  fileSize: number;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  audioStreams: number;
}

function frameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator = "1"] = value.split("/");
  const top = Number(numerator);
  const bottom = Number(denominator);
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0 ? top / bottom : 0;
}

function durationMs(document: FfprobeDocument, video: FfprobeStream): number {
  const seconds = Number(document.format?.duration ?? video.duration);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : 0;
}

export function validateExportArtifactProbe(
  document: FfprobeDocument,
  expected: ExportArtifactExpectation,
  fileSize: number,
): VerifiedExportArtifact {
  if (fileSize <= 0) throw new Error("Export artifact is empty.");
  const streams = document.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("Export artifact has no video stream.");
  const width = Number(video.width ?? 0);
  const height = Number(video.height ?? 0);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(
      `Export dimensions are ${width}x${height}; expected ${expected.width}x${expected.height}.`,
    );
  }
  const fps = frameRate(video.avg_frame_rate || video.r_frame_rate);
  // GIF stores frame delays in centiseconds, so an otherwise correct CFR
  // animation can probe slightly below its requested rate (for example,
  // 48 frames at 30 fps reports 179/6). Video containers remain strict.
  const fpsTolerance = expected.format === "gif" ? Math.max(0.25, expected.fps * 0.01) : 0.02;
  if (!Number.isFinite(fps) || Math.abs(fps - expected.fps) > fpsTolerance) {
    throw new Error(`Export FPS is ${fps || "unknown"}; expected ${expected.fps}.`);
  }
  const actualDurationMs = durationMs(document, video);
  const durationToleranceMs = Math.max(1_000 / expected.fps, 50);
  if (Math.abs(actualDurationMs - expected.durationMs) > durationToleranceMs) {
    throw new Error(
      `Export duration is ${Math.round(actualDurationMs)}ms; expected ${expected.durationMs}ms (±${Math.round(durationToleranceMs)}ms).`,
    );
  }
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio").length;
  if (expected.expectAudio && audioStreams === 0) {
    throw new Error("Export artifact is missing the expected audio stream.");
  }
  if (!expected.expectAudio && audioStreams > 0) {
    throw new Error(`${expected.format.toUpperCase()} export unexpectedly contains audio.`);
  }
  return {
    fileSize,
    width,
    height,
    fps,
    durationMs: actualDurationMs,
    audioStreams,
  };
}

async function ffprobeDocument(filePath: string): Promise<FfprobeDocument> {
  const { stdout } = await execFileAsync(
    exportFfprobePath(),
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration:format=duration",
      "-of",
      "json",
      filePath,
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as FfprobeDocument;
}

export async function sourceHasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    exportFfprobePath(),
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=index",
      "-of",
      "json",
      filePath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { streams?: unknown[] };
  return (parsed.streams?.length ?? 0) > 0;
}

export async function verifyExportArtifact(
  filePath: string,
  expected: ExportArtifactExpectation,
): Promise<VerifiedExportArtifact> {
  const stat = await fs.stat(filePath);
  const probe = validateExportArtifactProbe(await ffprobeDocument(filePath), expected, stat.size);
  await execFileAsync(
    exportFfmpegPath(),
    ["-v", "error", "-i", filePath, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return probe;
}

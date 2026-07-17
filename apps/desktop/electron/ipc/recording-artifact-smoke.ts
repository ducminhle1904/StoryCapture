import fs from "node:fs/promises";
import path from "node:path";

import { ffmpegExecutablePath } from "./export-binaries";
import { startRecordingFfmpegPipe } from "./legacy/capture-preview";
import { runFfmpeg } from "./legacy/recording";
import { probeRecording, type RecordingProbeResult } from "./media-probe";

type ValidRecordingProbe = Extract<RecordingProbeResult, { status: "valid" }>;

export interface PackagedRecordingSmokeEvidence {
  binaryLayout: "app.asar.unpacked" | "filesystem";
  streamingBytes: number;
  finalizedBytes: number;
  streamingProbe: ValidRecordingProbe;
  finalizedProbe: ValidRecordingProbe;
}

function requireValidProbe(
  result: RecordingProbeResult,
  phase: "streaming" | "finalized",
): ValidRecordingProbe {
  if (result.status === "valid") return result;
  throw new Error(`Packaged ${phase} recording probe failed: ${result.reason}`);
}

function solidBgraFrame(width: number, height: number, red: number, green: number): Buffer {
  const frame = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < frame.length; offset += 4) {
    frame[offset] = 32;
    frame[offset + 1] = green;
    frame[offset + 2] = red;
    frame[offset + 3] = 255;
  }
  return frame;
}

export async function runPackagedRecordingSmoke(
  outputDir: string,
): Promise<PackagedRecordingSmokeEvidence> {
  const binary = ffmpegExecutablePath();
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  if (binary.includes(asarSegment)) {
    throw new Error("Packaged recording FFmpeg resolved inside app.asar");
  }
  const binaryLayout = binary.includes(`${path.sep}app.asar.unpacked${path.sep}`)
    ? "app.asar.unpacked"
    : "filesystem";

  await fs.mkdir(outputDir, { recursive: true });
  const streamingPath = path.join(outputDir, "streaming.mp4");
  const finalizedPath = path.join(outputDir, "finalized.mp4");
  const width = 16;
  const height = 16;
  const fps = 2;
  const { child, done } = startRecordingFfmpegPipe([
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "bgra",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-frames:v",
    "2",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    streamingPath,
  ]);
  void done.catch(() => undefined);
  if (!child.stdin) {
    child.kill("SIGKILL");
    await done.catch(() => undefined);
    throw new Error("Packaged recording smoke encoder stdin is unavailable");
  }
  child.stdin.write(solidBgraFrame(width, height, 220, 48));
  child.stdin.end(solidBgraFrame(width, height, 48, 220));
  await done;

  await runFfmpeg([
    "-y",
    "-i",
    streamingPath,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    finalizedPath,
  ]);

  const [streamingStat, finalizedStat, streamingProbe, finalizedProbe] = await Promise.all([
    fs.stat(streamingPath),
    fs.stat(finalizedPath),
    probeRecording(streamingPath),
    probeRecording(finalizedPath),
  ]);
  if (streamingStat.size === 0 || finalizedStat.size === 0) {
    throw new Error("Packaged recording smoke produced an empty video");
  }

  return {
    binaryLayout,
    streamingBytes: streamingStat.size,
    finalizedBytes: finalizedStat.size,
    streamingProbe: requireValidProbe(streamingProbe, "streaming"),
    finalizedProbe: requireValidProbe(finalizedProbe, "finalized"),
  };
}

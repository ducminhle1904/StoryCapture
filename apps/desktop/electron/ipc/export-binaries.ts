import path from "node:path";

import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpegStaticPath from "ffmpeg-static";

function unpackedBinaryPath(candidate: string): string {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  return candidate.includes(asarSegment)
    ? candidate.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : candidate;
}

export function exportFfmpegPath(): string {
  if (!ffmpegStaticPath) throw new Error("ffmpeg-static binary is unavailable");
  return unpackedBinaryPath(ffmpegStaticPath);
}

export function exportFfprobePath(): string {
  if (!ffprobeInstaller.path) throw new Error("ffprobe binary is unavailable");
  return unpackedBinaryPath(ffprobeInstaller.path);
}

export const exportBinaryPathForTest = unpackedBinaryPath;

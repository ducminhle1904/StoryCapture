import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import ffmpegPath from "ffmpeg-static";

const PROBE_TIMEOUT_MS = 5_000;

export type RecordingProbeResult =
  | {
      status: "valid";
      duration_ms: number | null;
      width: number | null;
      height: number | null;
      codec: string | null;
      container: string | null;
    }
  | {
      status: "invalid";
      reason: "empty" | "not_file" | "missing" | "timeout" | "unsupported_or_corrupt";
    };

export function parseFfmpegProbeOutput(
  stderr: string,
): Omit<Extract<RecordingProbeResult, { status: "valid" }>, "status"> {
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = stderr.match(/Video:\s*([^,\s]+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  const container = stderr.match(/Input #0,\s*([^,]+),/);
  return {
    duration_ms: duration
      ? Math.round(
          (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
        )
      : null,
    codec: video?.[1] ?? null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    container: container?.[1]?.trim() ?? null,
  };
}

export async function probeRecording(filePath: string): Promise<RecordingProbeResult> {
  let stat: Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { status: "invalid", reason: "missing" };
  }
  if (!stat.isFile()) return { status: "invalid", reason: "not_file" };
  if (stat.size === 0) return { status: "invalid", reason: "empty" };
  const binary = ffmpegPath;
  if (!binary) return { status: "invalid", reason: "unsupported_or_corrupt" };

  return new Promise((resolve) => {
    const child = spawn(
      binary,
      ["-hide_banner", "-i", filePath, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let settled = false;
    const finish = (result: RecordingProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: "invalid", reason: "timeout" });
    }, PROBE_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on("error", () => finish({ status: "invalid", reason: "unsupported_or_corrupt" }));
    child.on("close", (code) => {
      const metadata = parseFfmpegProbeOutput(stderr);
      finish(
        code === 0 && metadata.codec && metadata.width && metadata.height
          ? { status: "valid", ...metadata }
          : { status: "invalid", reason: "unsupported_or_corrupt" },
      );
    });
  });
}

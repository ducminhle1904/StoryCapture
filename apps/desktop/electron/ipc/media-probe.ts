import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";

import type { RecordingRational } from "@storycapture/shared-types/recording-v2";

import { ffmpegExecutablePath, ffprobeExecutablePath } from "./export-binaries";

const PROBE_TIMEOUT_MS = 120_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface RecordingProbeFrame {
  index: number;
  pts: number | null;
  pts_time_seconds: number | null;
  duration: number | null;
  duration_time_seconds: number | null;
  best_effort_timestamp: number | null;
  best_effort_timestamp_time_seconds: number | null;
}

export interface RecordingProbeColor {
  range: string | null;
  space: string | null;
  transfer: string | null;
  primaries: string | null;
}

export type RecordingProbeResult =
  | {
      status: "valid";
      duration_ms: number | null;
      width: number;
      height: number;
      codec: string;
      profile: string | null;
      pixel_format: string | null;
      color: RecordingProbeColor;
      container: string | null;
      bitrate: number | null;
      real_frame_rate: RecordingRational | null;
      average_frame_rate: RecordingRational | null;
      stream_time_base: RecordingRational | null;
      declared_frames: number | null;
      counted_frames: number | null;
      frames: RecordingProbeFrame[];
      full_decode_succeeded: boolean;
    }
  | {
      status: "invalid";
      reason: "empty" | "not_file" | "missing" | "timeout" | "unsupported_or_corrupt";
    };

export type RecordingDimensionProbeResult =
  | { status: "valid"; width: number; height: number }
  | {
      status: "invalid";
      reason: "empty" | "not_file" | "missing" | "timeout" | "unsupported_or_corrupt";
    };

interface FfprobeStreamJson {
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  width?: number | string;
  height?: number | string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  bit_rate?: string;
  nb_frames?: string;
  nb_read_frames?: string;
  duration?: string;
}

interface FfprobeFrameJson {
  pts?: number | string;
  pts_time?: string;
  pkt_pts?: number | string;
  pkt_pts_time?: string;
  pkt_duration?: number | string;
  pkt_duration_time?: string;
  duration?: number | string;
  duration_time?: string;
  best_effort_timestamp?: number | string;
  best_effort_timestamp_time?: string;
}

interface FfprobeOutputJson {
  streams?: FfprobeStreamJson[];
  frames?: FfprobeFrameJson[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  outputExceeded: boolean;
}

function finiteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "N/A") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseProbeRational(value: unknown): RecordingRational | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(-?\d+)\/(-?\d+)$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) {
    return null;
  }
  return { numerator, denominator };
}

export function parseFfmpegProbeOutput(stderr: string): {
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  container: string | null;
} {
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

export function parseFfprobeJsonOutput(
  stdout: string,
  fullDecodeSucceeded: boolean,
): Extract<RecordingProbeResult, { status: "valid" }> | null {
  let parsed: FfprobeOutputJson;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutputJson;
  } catch {
    return null;
  }
  const stream = parsed.streams?.[0];
  const width = finiteNumber(stream?.width);
  const height = finiteNumber(stream?.height);
  if (!stream?.codec_name || !width || !height) return null;

  const frames = (parsed.frames ?? []).map((frame, index) => ({
    index,
    pts: finiteNumber(frame.pts ?? frame.pkt_pts),
    pts_time_seconds: finiteNumber(frame.pts_time ?? frame.pkt_pts_time),
    duration: finiteNumber(frame.duration ?? frame.pkt_duration),
    duration_time_seconds: finiteNumber(frame.duration_time ?? frame.pkt_duration_time),
    best_effort_timestamp: finiteNumber(frame.best_effort_timestamp),
    best_effort_timestamp_time_seconds: finiteNumber(frame.best_effort_timestamp_time),
  }));
  const countedFrames = finiteNumber(stream.nb_read_frames);
  const streamDuration = finiteNumber(stream.duration);
  const formatDuration = finiteNumber(parsed.format?.duration);

  return {
    status: "valid",
    duration_ms:
      streamDuration !== null
        ? Math.round(streamDuration * 1000)
        : formatDuration !== null
          ? Math.round(formatDuration * 1000)
          : null,
    width,
    height,
    codec: stream.codec_name,
    profile: stream.profile ?? null,
    pixel_format: stream.pix_fmt ?? null,
    color: {
      range: stream.color_range ?? null,
      space: stream.color_space ?? null,
      transfer: stream.color_transfer ?? null,
      primaries: stream.color_primaries ?? null,
    },
    container: parsed.format?.format_name?.split(",")[0] ?? null,
    bitrate: finiteNumber(stream.bit_rate) ?? finiteNumber(parsed.format?.bit_rate),
    real_frame_rate: parseProbeRational(stream.r_frame_rate),
    average_frame_rate: parseProbeRational(stream.avg_frame_rate),
    stream_time_base: parseProbeRational(stream.time_base),
    declared_frames: finiteNumber(stream.nb_frames),
    counted_frames:
      countedFrames !== null && countedFrames > 0
        ? countedFrames
        : frames.length > 0
          ? frames.length
          : null,
    frames,
    full_decode_succeeded: fullDecodeSucceeded,
  };
}

export function parseFfprobeDimensionsOutput(
  stdout: string,
): Extract<RecordingDimensionProbeResult, { status: "valid" }> | null {
  let parsed: FfprobeOutputJson;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutputJson;
  } catch {
    return null;
  }
  const width = finiteNumber(parsed.streams?.[0]?.width);
  const height = finiteNumber(parsed.streams?.[0]?.height);
  return width && height ? { status: "valid", width, height } : null;
}

async function runProcess(
  binary: string,
  args: string[],
  timeoutMs: number,
  captureStdout: boolean,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let outputExceeded = false;
    child.stderr?.resume();
    const stdoutText = () => Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: stdoutText(), timedOut: true, outputExceeded });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = MAX_PROBE_OUTPUT_BYTES - stdoutBytes;
      if (remaining > 0) {
        const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        stdoutChunks.push(retained);
        stdoutBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", () =>
      finish({ code: null, stdout: stdoutText(), timedOut: false, outputExceeded }),
    );
    child.on("close", (code) =>
      finish({ code, stdout: stdoutText(), timedOut: false, outputExceeded }),
    );
  });
}

export async function probeRecording(
  filePath: string,
  options: { timeoutMs?: number; verifiedFullDecode?: boolean } = {},
): Promise<RecordingProbeResult> {
  let stat: Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { status: "invalid", reason: "missing" };
  }
  if (!stat.isFile()) return { status: "invalid", reason: "not_file" };
  if (stat.size === 0) return { status: "invalid", reason: "empty" };

  let ffprobeBinary: string;
  let ffmpegBinary: string;
  try {
    ffprobeBinary = ffprobeExecutablePath();
    ffmpegBinary = ffmpegExecutablePath();
  } catch {
    return { status: "invalid", reason: "unsupported_or_corrupt" };
  }

  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const probe = await runProcess(
    ffprobeBinary,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-show_frames",
      "-show_entries",
      "stream=codec_name,profile,pix_fmt,color_range,color_space,color_transfer,color_primaries,width,height,r_frame_rate,avg_frame_rate,time_base,bit_rate,nb_frames,nb_read_frames,duration:frame=pts,pts_time,pkt_pts,pkt_pts_time,pkt_duration,pkt_duration_time,duration,duration_time,best_effort_timestamp,best_effort_timestamp_time:format=format_name,duration,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    timeoutMs,
    true,
  );
  if (probe.timedOut) return { status: "invalid", reason: "timeout" };
  if (probe.code !== 0 || probe.outputExceeded) {
    return { status: "invalid", reason: "unsupported_or_corrupt" };
  }

  if (options.verifiedFullDecode) {
    return (
      parseFfprobeJsonOutput(probe.stdout, true) ?? {
        status: "invalid",
        reason: "unsupported_or_corrupt",
      }
    );
  }
  const decode = await runProcess(
    ffmpegBinary,
    ["-v", "error", "-xerror", "-i", filePath, "-map", "0:v:0", "-f", "null", "-"],
    timeoutMs,
    false,
  );
  if (decode.timedOut) return { status: "invalid", reason: "timeout" };
  return (
    parseFfprobeJsonOutput(probe.stdout, decode.code === 0) ?? {
      status: "invalid",
      reason: "unsupported_or_corrupt",
    }
  );
}

export async function probeRecordingDimensions(
  filePath: string,
  options: { timeoutMs?: number } = {},
): Promise<RecordingDimensionProbeResult> {
  let stat: Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return { status: "invalid", reason: "missing" };
  }
  if (!stat.isFile()) return { status: "invalid", reason: "not_file" };
  if (stat.size === 0) return { status: "invalid", reason: "empty" };

  let ffprobeBinary: string;
  try {
    ffprobeBinary = ffprobeExecutablePath();
  } catch {
    return { status: "invalid", reason: "unsupported_or_corrupt" };
  }
  const probe = await runProcess(
    ffprobeBinary,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    options.timeoutMs ?? PROBE_TIMEOUT_MS,
    true,
  );
  if (probe.timedOut) return { status: "invalid", reason: "timeout" };
  if (probe.code !== 0 || probe.outputExceeded) {
    return { status: "invalid", reason: "unsupported_or_corrupt" };
  }
  return (
    parseFfprobeDimensionsOutput(probe.stdout) ?? {
      status: "invalid",
      reason: "unsupported_or_corrupt",
    }
  );
}

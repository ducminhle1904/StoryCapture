import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import {
  cadenceWarning,
  recordingPngSequenceInputArgs,
  recordingQualityArgs,
  recordingVideoFilters,
} from "../recording-pipeline";
import { authorSession, ffmpegCropPlan, percentile, queueRecordingFrame } from "./capture-preview";
import { hostLog, recordingSessions, sendChannel } from "./shared";

export async function setRecordingAudio(raw: unknown): Promise<null> {
  const payload = raw as { session?: { id?: unknown }; id?: unknown; bytes?: unknown } | undefined;
  const id = String(payload?.session?.id ?? payload?.id ?? "");
  const session = recordingSessions.get(id);
  if (!session) return null;
  const bytes = payload?.bytes;
  const buffer =
    bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : bytes instanceof ArrayBuffer
        ? Buffer.from(bytes)
        : null;
  if (!buffer || buffer.byteLength === 0) return null;
  const audioPath = path.join(session.framesDir, "microphone.webm");
  await fs.writeFile(audioPath, buffer);
  session.audioPath = audioPath;
  return null;
}

export function runFfmpeg(ffmpegArgs: string[]): Promise<void> {
  const binary = ffmpegPath;
  if (!binary) throw new Error("ffmpeg-static binary is unavailable");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ffmpegArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function stopRecording(raw: unknown) {
  const id = typeof raw === "string" ? raw : String((raw as { id?: string } | undefined)?.id ?? "");
  const session = recordingSessions.get(id);
  if (!session) throw new Error(`recording session ${id} not found`);
  recordingSessions.delete(id);
  session.pauseGate.cancel();
  clearInterval(session.heartbeat);
  if (session.captureTimer) clearInterval(session.captureTimer);
  if (session.authorPaintHandler && session.target.kind === "author_preview") {
    try {
      authorSession(session.target.stream_id).window.webContents.off(
        "paint",
        session.authorPaintHandler,
      );
    } catch {
      // The preview may already be gone during teardown.
    }
  }
  if (session.captureInFlight) await session.captureInFlight;
  if (session.frameSeq === 0) {
    try {
      await queueRecordingFrame(session);
    } catch {
      // The common no-frame error below is clearer for callers.
    }
  }
  if (session.frameSeq === 0) {
    await fs.rm(session.framesDir, { recursive: true, force: true });
    session.ffmpegProcess?.kill("SIGKILL");
    throw new Error("recording stopped before any capture frames were written");
  }

  session.lifecycle = "stopping";
  const mediaClock = session.mediaClock.freeze();
  const wallDurationSec = Math.max(1, (Date.now() - session.startedAt) / 1000);
  if (session.streaming) {
    if (session.ffmpegProcess?.stdin && !session.ffmpegProcess.stdin.destroyed) {
      session.ffmpegProcess.stdin.end();
    }
    if (session.ffmpegDone) await session.ffmpegDone;
    if (session.encoderError) throw session.encoderError;
  } else {
    const ffmpegArgs = [
      "-y",
      ...recordingPngSequenceInputArgs(session.effectiveFps),
      "-i",
      path.join(session.framesDir, "frame-%06d.png"),
    ];
    if (session.audioPath) {
      ffmpegArgs.push("-i", session.audioPath);
    }
    const cropPlan = ffmpegCropPlan(session.frameCrop, session.width, session.height);
    const sourceWidth = cropPlan?.width ?? session.width;
    const sourceHeight = cropPlan?.height ?? session.height;
    const filters = [
      cropPlan?.filter,
      ...recordingVideoFilters({
        sourceWidth,
        sourceHeight,
        outputWidth: session.outputWidth,
        outputHeight: session.outputHeight,
        fitMode: session.fitMode,
        padColor: session.padColor,
        scaleAlgo: session.scaleAlgo,
      }),
    ].filter((filter): filter is string => Boolean(filter));
    ffmpegArgs.push("-r", String(session.fps), "-vf", filters.join(","));
    if (session.audioPath) {
      ffmpegArgs.push("-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "160k", "-shortest");
    } else {
      ffmpegArgs.push("-an");
    }
    ffmpegArgs.push(
      "-c:v",
      "libx264",
      ...recordingQualityArgs(session.qualityPreset),
      "-movflags",
      "+faststart",
      session.outputPath,
    );
    await runFfmpeg(ffmpegArgs);
  }
  await fs.rm(session.framesDir, { recursive: true, force: true });
  const stat = await fs.stat(session.outputPath);
  const encodedFps = mediaClock.fpsNum / mediaClock.fpsDen;
  const sourceFramesReceived = session.streaming ? session.sourceFramesReceived : session.frameSeq;
  const sourceFps = sourceFramesReceived / wallDurationSec;
  const actualCaptureFps = session.streaming ? sourceFps : encodedFps;
  const warning = cadenceWarning({
    actualFps: actualCaptureFps,
    requestedFps: session.effectiveFps,
  });
  if (warning) {
    void hostLog("warn", "recording_capture_cadence_below_target", {
      session_id: session.id,
      target_kind: session.target.kind,
      requested_fps: session.requestedFps,
      effective_fps: session.effectiveFps,
      actual_capture_fps: actualCaptureFps.toFixed(2),
      frames_written: session.frameSeq,
      frames_dropped: session.framesDropped,
      late_frames: session.lateFrames,
      skipped_ticks: session.skippedTicks,
      encoder_backpressure_events: session.encoderBackpressureEvents,
      cadence_warning: warning.code,
    });
  }
  const result = {
    output_path: session.outputPath,
    duration_ms: Math.round(mediaClock.durationUs / 1000),
    frame_count: mediaClock.frameCount,
    duration_us: mediaClock.durationUs,
    media_clock: {
      clock: mediaClock.clock,
      unit: mediaClock.unit,
      fps_num: mediaClock.fpsNum,
      fps_den: mediaClock.fpsDen,
      origin_frame: mediaClock.originFrame,
      frame_count: mediaClock.frameCount,
      duration_us: mediaClock.durationUs,
    },
    bytes: stat.size,
    frames_written: session.frameSeq,
    frames_encoded: session.frameSeq,
    frames_dropped: session.framesDropped,
    requested_fps: session.requestedFps,
    effective_fps: session.effectiveFps,
    actual_capture_fps: Number(actualCaptureFps.toFixed(2)),
    encoded_fps: Number(encodedFps.toFixed(2)),
    source_capture_fps: Number(sourceFps.toFixed(2)),
    source_frames_received: sourceFramesReceived,
    skipped_ticks: session.skippedTicks,
    encoder_backpressure_events: session.encoderBackpressureEvents,
    late_frames: session.lateFrames,
    capture_duration_ms_p50: percentile(session.captureDurationMs, 50),
    capture_duration_ms_p95: percentile(session.captureDurationMs, 95),
    cadence_warning: warning?.code ?? null,
    cadence_warning_message: warning?.message ?? null,
    output_width: session.outputWidth,
    output_height: session.outputHeight,
    fit_mode: session.fitMode,
    quality_preset: session.qualityPreset,
    encoder_input: session.streaming ? "author_preview_raw_bgra_pipe" : "png_sequence",
  };
  session.lifecycle = "finalized";
  sendChannel(session.eventTarget, session.eventChannelId, {
    type: "completed",
    result,
  });
  return result;
}

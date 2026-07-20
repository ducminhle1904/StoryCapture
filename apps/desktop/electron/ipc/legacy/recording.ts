import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ffmpegExecutablePath } from "../export-binaries";
import { recordEngineLog } from "../recording-observability";
import {
  cadenceWarning,
  recordingPngSequenceInputArgs,
  recordingQualityArgs,
  recordingVideoFilters,
} from "../recording-pipeline";
import {
  setStrictBrowserRecordingAudio,
  stopStrictBrowserRecording,
} from "../recording-strict-browser-lifecycle";
import { authorSession, ffmpegCropPlan, percentile, queueRecordingFrame } from "./capture-preview";
import { recordingEncoderFailure, recordingErrorCode } from "./recording-errors";
import { closeChannel, type RecordingSession, recordingSessions, sendChannel } from "./shared";

function recordingBackendId(session: RecordingSession): string {
  return session.target.kind === "author_preview"
    ? "electron_author_preview"
    : "electron_desktop_capturer";
}

function recordTerminalFailure(
  session: RecordingSession,
  error: unknown,
  phase: string,
  reasonCode: string,
): void {
  const encoderErrorCode = recordingErrorCode(error);
  void recordEngineLog({
    level: "error",
    event: "recording.terminal",
    context: {
      session_id: session.id,
      backend_id: recordingBackendId(session),
      phase,
      reason_code: reasonCode,
    },
    details: {
      outcome: "failed",
      target_kind: session.target.kind,
      frames_written: session.frameSeq,
      frames_dropped: session.framesDropped,
      ...(encoderErrorCode ? { encoder_error_code: encoderErrorCode } : {}),
    },
    error,
  });
}

export async function setRecordingAudio(raw: unknown): Promise<null> {
  if (await setStrictBrowserRecordingAudio(raw)) return null;
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
  let binary: string;
  try {
    binary = ffmpegExecutablePath();
  } catch (error) {
    throw recordingEncoderFailure(error, "finalize");
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ffmpegArgs, {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      reject(recordingEncoderFailure(error, "finalize"));
      return;
    }
    const childStderr = child.stderr;
    if (!childStderr) {
      child.kill("SIGKILL");
      reject(recordingEncoderFailure(new Error("ffmpeg stderr pipe was not created"), "finalize"));
      return;
    }
    let stderr = "";
    childStderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(recordingEncoderFailure(error, "finalize")));
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
  const strictResult = await stopStrictBrowserRecording(id);
  if (strictResult) return strictResult;
  const session = recordingSessions.get(id);
  if (!session) throw new Error(`recording session ${id} not found`);
  recordingSessions.delete(id);
  session.pauseGate.cancel();
  session.actionLandmarks.cancelAll();
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
    const error = new Error("recording stopped before any capture frames were written");
    recordTerminalFailure(session, error, "stop", "no_capture_frames");
    throw error;
  }

  session.lifecycle = "stopping";
  const mediaClock = session.mediaClock.freeze();
  const wallDurationSec = Math.max(1, (Date.now() - session.startedAt) / 1000);
  if (session.streaming) {
    try {
      if (session.ffmpegProcess?.stdin && !session.ffmpegProcess.stdin.destroyed) {
        session.ffmpegProcess.stdin.end();
      }
      if (session.ffmpegDone) await session.ffmpegDone;
      if (session.encoderError) throw session.encoderError;
    } catch (error) {
      recordTerminalFailure(session, error, "finalize", "encoder_finalize_failed");
      throw error;
    }
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
    try {
      await runFfmpeg(ffmpegArgs);
    } catch (error) {
      if (session.audioPath) {
        void recordEngineLog({
          level: "error",
          event: "recording.audio.finalize_failed",
          context: {
            session_id: session.id,
            backend_id: recordingBackendId(session),
            phase: "mux",
            reason_code: "audio_mux_failed",
          },
          error,
        });
      }
      recordTerminalFailure(session, error, "finalize", "encoder_finalize_failed");
      throw error;
    }
  }
  await fs.rm(session.framesDir, { recursive: true, force: true });
  const stat = await fs.stat(session.outputPath).catch((error: unknown) => {
    recordTerminalFailure(session, error, "artifact", "output_missing");
    throw error;
  });
  const encodedFps = mediaClock.fpsNum / mediaClock.fpsDen;
  const sourceFramesReceived = session.streaming ? session.sourceFramesReceived : session.frameSeq;
  const sourceFps = sourceFramesReceived / wallDurationSec;
  const actualCaptureFps = session.streaming ? sourceFps : encodedFps;
  const warning = cadenceWarning({
    actualFps: actualCaptureFps,
    requestedFps: session.effectiveFps,
  });
  if (warning) {
    void recordEngineLog({
      level: "warn",
      event: "recording.health.state_changed",
      context: {
        session_id: session.id,
        backend_id: recordingBackendId(session),
        phase: "finalize",
        reason_code: warning.code,
      },
      details: {
        verdict: "degraded",
        target_kind: session.target.kind,
        requested_fps: session.requestedFps,
        effective_fps: session.effectiveFps,
        actual_capture_fps: Number(actualCaptureFps.toFixed(2)),
        frames_written: session.frameSeq,
        frames_dropped: session.framesDropped,
        late_frames: session.lateFrames,
        skipped_ticks: session.skippedTicks,
        encoder_backpressure_events: session.encoderBackpressureEvents,
      },
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
  if (session.target.kind === "author_preview") {
    void recordEngineLog({
      event: "recording.preview.stopped",
      context: {
        session_id: session.id,
        backend_id: recordingBackendId(session),
        phase: "finalize",
      },
      details: { frames_written: session.frameSeq, frames_dropped: session.framesDropped },
    });
  }
  void recordEngineLog({
    event: "recording.backend.stopped",
    context: {
      session_id: session.id,
      backend_id: recordingBackendId(session),
      phase: "finalize",
    },
    details: { frames_written: session.frameSeq, frames_dropped: session.framesDropped },
  });
  void recordEngineLog({
    event: "recording.terminal",
    context: {
      session_id: session.id,
      backend_id: recordingBackendId(session),
      phase: "finalize",
      verdict: "passed",
    },
    details: {
      outcome: "completed",
      duration_ms: result.duration_ms,
      frames_written: result.frames_written,
      frames_dropped: result.frames_dropped,
      bytes: result.bytes,
    },
  });
  sendChannel(session.eventTarget, session.eventChannelId, {
    type: "completed",
    result,
  });
  closeChannel(session.eventTarget, session.eventChannelId);
  return result;
}

import { spawn } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { RecordingOutcomeV1 } from "@storycapture/shared-types";
import ffmpegPath from "ffmpeg-static";
import {
  actionsSidecarPath,
  recordingActionsFromSession,
  writeActionsSidecarAtomic,
} from "../action-timeline";
import {
  type AudioTrackRole,
  authorPreviewTabGrants,
  type RecordingAudioTrackDescriptor,
  type RecordingAudioTrackEventIdentity,
  recordingAudioMode,
  recordingAudioTracks,
  recordingCompatibilityMixArgs,
  writeRecordingAudioDescriptors,
} from "../audio-tracks";
import { writeJsonAtomic } from "../json-store";
import { probeRecording } from "../media-probe";
import {
  buildLegacyRecordingAvMuxArgs,
  buildRecordingAvMuxPlan,
  monotonicEpochMilliseconds,
  type RecordingAudioOperationAck,
  type RecordingAudioStreamSnapshot,
  type RecordingAvSnapshot,
  recordingAudioContainerForMimeType,
  recordingAvMode,
  recordingAvSessions,
} from "../recording-av-clock";
import {
  type RecordingBundleWriter,
  recordingBundleForSession,
  recordingBundlePublicVideoPath,
} from "../recording-bundle";
import {
  disposeRecordingCheckpoints,
  recordingCheckpointsForSession,
} from "../recording-checkpoints";
import { recordingHealth } from "../recording-health";
import {
  type RecordingStatusResultV1,
  recordingLifecycle,
  type StopIntent,
} from "../recording-lifecycle";
import { recordingFramePtsUs } from "../recording-media-clock";
import { recordEngineLog } from "../recording-observability";
import {
  classifyRecordingOutcome,
  classifyStrictRecordingOutcome,
  recordingOutcomeMode,
} from "../recording-outcome";
import {
  cadenceWarning,
  recordingPngSequenceInputArgs,
  recordingQualityArgs,
  recordingVideoFilters,
} from "../recording-pipeline";
import { acceptedRecordingPreflights } from "../recording-preflight";
import {
  RecordingReadinessError,
  type RecordingReadinessResultV1,
  recordingReadiness,
} from "../recording-readiness";
import { recordingRepairMode } from "../recording-repair";
import {
  assembleRecordingSegments,
  prepareLiveRepairAssembly,
  type RecordingAssemblyAudioSource,
  type RecordingRevision,
  recordingAssemblyInputSha256,
} from "../recording-segment-stitch";
import { recordingSessionJournal } from "../recording-session-journal";
import {
  authorSession,
  ffmpegCropPlan,
  percentile,
  queueRecordingFrame,
  recordingCaptureActiveMediaMs,
  recordingFrameCommitBudgetMs,
} from "./capture-preview";
import { hostLog, type RecordingSession, recordingSessions, sendChannel } from "./shared";

interface RecordingAudioSink {
  file: FileHandle | null;
  path: string;
}

const recordingAudioSinks = new Map<string, RecordingAudioSink>();
const recordingAudioOperationTails = new Map<string, Promise<void>>();
const RECORDING_AUDIO_DRAIN_TIMEOUT_MS = 5_000;

function recordingMonotonicEpochMs(): number {
  return monotonicEpochMilliseconds(performance.timeOrigin, performance.now());
}

function recordingAudioSessionId(raw: unknown): string {
  const payload = raw as { session?: { id?: unknown }; id?: unknown } | undefined;
  return String(payload?.session?.id ?? payload?.id ?? "");
}

function recordingAudioBytes(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function sendRecordingAudioWarning(session: RecordingSession, reason: string): void {
  sendChannel(session.eventTarget, session.eventChannelId, {
    type: "audio-unavailable",
    reason,
  });
}

async function closeRecordingAudioSink(id: string): Promise<void> {
  const sink = recordingAudioSinks.get(id);
  if (!sink?.file) return;
  const file = sink.file;
  sink.file = null;
  await file.close();
}

async function closeRecordingAudioSinksForSession(sessionId: string): Promise<void> {
  const keys = [...recordingAudioSinks.keys()].filter(
    (key) => key === sessionId || key.startsWith(`${sessionId}:`),
  );
  await Promise.all(keys.map((key) => closeRecordingAudioSink(key).catch(() => undefined)));
  for (const key of keys) recordingAudioSinks.delete(key);
}

function acceptedAudioAck(sequence: number): RecordingAudioOperationAck {
  return { status: "accepted", sequence, durable: true, nextSequence: sequence + 1 };
}

function multitrackIdentity(
  sessionId: string,
  payload: Record<string, unknown>,
): RecordingAudioTrackEventIdentity {
  const rawRole = String(payload.role ?? "") as AudioTrackRole;
  if (rawRole !== "microphone" && rawRole !== "tab" && rawRole !== "system") {
    throw new Error("recording audio role invalid");
  }
  return {
    session_id: sessionId,
    track_id: String(payload.track_id ?? ""),
    role: rawRole,
    source_id: payload.source_id == null ? null : String(payload.source_id),
    capture_token: String(payload.capture_token ?? payload.audio_capture_id ?? ""),
  };
}

async function processMultitrackAudioStream(
  payload: Record<string, unknown>,
  session: RecordingSession,
): Promise<RecordingAudioOperationAck> {
  const identity = multitrackIdentity(session.id, payload);
  recordingAudioTracks.authenticate(identity);
  const runtime = recordingAvSessions.require(session.id);
  const operation = String(payload.operation ?? "");
  const sequence = Number(payload.sequence);
  const monotonicEpochMs = Number(payload.monotonic_epoch_ms);
  const sinkId = `${session.id}:${identity.track_id}`;
  const compatibilityRequest =
    recordingAudioTracks.request(session.id, "microphone") ??
    (recordingAudioMode() === "multitrack_shadow"
      ? null
      : recordingAudioTracks.request(session.id, "tab"));
  const isCompatibilityTrack =
    runtime.audioRequested && compatibilityRequest?.track_id === identity.track_id;

  if (operation === "begin") {
    if (recordingAudioSinks.has(sinkId)) return acceptedAudioAck(sequence);
    const mimeType = String(payload.mime_type ?? "");
    const container = recordingAudioContainerForMimeType(mimeType);
    const bundle = recordingBundleForSession(session.id);
    const audioPath = bundle
      ? path.join(bundle.allocation.audioDir, `${identity.role}.${container}`)
      : path.join(session.framesDir, `${identity.role}.${container}`);
    const relativePath = bundle
      ? path.relative(bundle.allocation.stagingRoot, audioPath).split(path.sep).join("/")
      : `audio/${identity.role}.${container}`;
    const file = await fs.open(audioPath, "wx");
    try {
      if (isCompatibilityTrack) {
        runtime.assertAudioCaptureId(identity.capture_token);
        runtime.audio.begin({
          sequence,
          sessionId: session.id,
          audioCaptureId: identity.capture_token,
          monotonicEpochMs,
          mimeType,
          container,
        });
      }
      recordingAudioTracks.begin(identity, {
        sequence,
        relativePath,
        container,
        codec: typeof payload.codec === "string" ? payload.codec : null,
        sampleRateHz: Number.isFinite(Number(payload.sample_rate_hz))
          ? Number(payload.sample_rate_hz)
          : null,
        channels: Number.isFinite(Number(payload.channels)) ? Number(payload.channels) : null,
      });
      recordingAudioSinks.set(sinkId, { file, path: audioPath });
      if (isCompatibilityTrack) session.audioPath = audioPath;
      return acceptedAudioAck(sequence);
    } catch (error) {
      await file.close().catch(() => undefined);
      await fs.rm(audioPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  if (operation === "abort") {
    const rawReason = String(payload.reason ?? "audio_stream_aborted");
    recordingAudioTracks.fail(identity, { sequence, reason: rawReason });
    const ack = isCompatibilityTrack
      ? runtime.audio.abort({
          sequence,
          monotonicEpochMs,
          reason: rawReason.includes("backpressure")
            ? "audio_backpressure_overflow"
            : "audio_stream_aborted",
        })
      : acceptedAudioAck(sequence);
    await closeRecordingAudioSink(sinkId).catch(() => undefined);
    if (isCompatibilityTrack) runtime.markAudioTerminal();
    sendRecordingAudioWarning(session, rawReason);
    return ack;
  }
  const sink = recordingAudioSinks.get(sinkId);
  if (!sink) throw new Error(`recording audio track ${identity.track_id} has not begun`);
  if (operation === "chunk") {
    const bytes = recordingAudioBytes(payload.bytes);
    if (!bytes?.byteLength) throw new Error("recording audio chunk bytes are required");
    if (!sink.file) throw new Error("recording audio sink is closed");
    let compatibilityPrepared = false;
    if (isCompatibilityTrack) {
      const accepted = runtime.audio.prepareChunk({
        sequence,
        monotonicEpochMs,
        byteLength: bytes.byteLength,
        durationUs: Number(payload.duration_us ?? 0),
      });
      if (accepted.status === "duplicate") return accepted;
      compatibilityPrepared = true;
    }
    recordingAudioTracks.chunk(identity, {
      sequence,
      byteLength: bytes.byteLength,
      ptsUs: Number.isFinite(Number(payload.pts_us)) ? Number(payload.pts_us) : null,
      monotonicEpochMs,
      durationUs: Number(payload.duration_us ?? 0),
    });
    try {
      const write = await sink.file.write(bytes);
      if (write.bytesWritten !== bytes.byteLength) {
        throw new Error("recording audio chunk was only partially written");
      }
      await sink.file.sync();
      if (compatibilityPrepared) return runtime.audio.acknowledgeChunk(sequence);
      return acceptedAudioAck(sequence);
    } catch (error) {
      recordingAudioTracks.fail(identity, {
        sequence: sequence + 1,
        reason: "audio_stream_aborted",
      });
      if (isCompatibilityTrack) {
        runtime.audio.abort({
          sequence: sequence + 1,
          monotonicEpochMs: Math.max(monotonicEpochMs, recordingMonotonicEpochMs()),
          reason: "audio_stream_aborted",
        });
        runtime.markAudioTerminal();
      }
      await closeRecordingAudioSink(sinkId).catch(() => undefined);
      sendRecordingAudioWarning(session, "audio_stream_aborted");
      throw error;
    }
  }
  if (operation === "pause" || operation === "resume") {
    recordingAudioTracks.control(identity, sequence, operation);
    if (isCompatibilityTrack) return runtime.audio[operation]({ sequence, monotonicEpochMs });
    return acceptedAudioAck(sequence);
  }
  if (operation === "end") {
    const descriptor = recordingAudioTracks.complete(identity, {
      sequence,
      totalBytes: Number(payload.total_bytes),
      totalChunks: Number(payload.total_chunks),
    });
    const ack = isCompatibilityTrack
      ? runtime.audio.end({
          sequence,
          monotonicEpochMs,
          totalBytes: Number(payload.total_bytes),
          totalChunks: Number(payload.total_chunks),
        })
      : acceptedAudioAck(sequence);
    await sink.file?.sync();
    await closeRecordingAudioSink(sinkId);
    if (isCompatibilityTrack) runtime.markAudioTerminal();
    if (descriptor.status === "failed") sendRecordingAudioWarning(session, "audio_zero_samples");
    return ack;
  }
  throw new Error(`unsupported recording audio stream operation ${operation}`);
}

async function processRecordingAudioStream(raw: unknown): Promise<RecordingAudioOperationAck> {
  const payload = raw as Record<string, unknown> & {
    session?: { id?: unknown };
  };
  const id = recordingAudioSessionId(payload);
  const session = recordingSessions.get(id);
  if (!session) throw new Error(`recording session ${id} not found`);
  if (recordingAudioMode() !== "legacy" && recordingAudioTracks.descriptors(id).length > 0) {
    return processMultitrackAudioStream(payload, session);
  }
  const runtime = recordingAvSessions.require(id);
  if (!runtime.audioRequested) throw new Error(`recording session ${id} did not request audio`);
  const operation = String(payload.operation ?? "");
  const sequence = Number(payload.sequence);
  const monotonicEpochMs = Number(payload.monotonic_epoch_ms);
  const audioCaptureId = String(payload.audio_capture_id ?? "");
  runtime.assertAudioCaptureId(audioCaptureId);

  if (operation === "begin") {
    const existing = recordingAudioSinks.get(id);
    if (existing) {
      return runtime.audio.begin({
        sequence,
        sessionId: id,
        audioCaptureId,
        monotonicEpochMs,
        mimeType: String(payload.mime_type ?? ""),
      });
    }
    const mimeType = String(payload.mime_type ?? "");
    const container = recordingAudioContainerForMimeType(mimeType);
    const bundle = recordingBundleForSession(id);
    const audioPath = bundle
      ? path.join(bundle.allocation.audioDir, `microphone.${container}`)
      : path.join(session.framesDir, `microphone.${container}`);
    const file = await fs.open(audioPath, "wx");
    try {
      const ack = runtime.audio.begin({
        sequence,
        sessionId: id,
        audioCaptureId,
        monotonicEpochMs,
        mimeType,
        container,
      });
      recordingAudioSinks.set(id, { file, path: audioPath });
      session.audioPath = audioPath;
      return ack;
    } catch (error) {
      await file.close().catch(() => undefined);
      await fs.rm(audioPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  const sink = recordingAudioSinks.get(id);
  if (!sink) throw new Error(`recording audio stream ${id} has not begun`);
  if (operation === "chunk") {
    const bytes = recordingAudioBytes(payload.bytes);
    if (!bytes?.byteLength) throw new Error("recording audio chunk bytes are required");
    const accepted = runtime.audio.prepareChunk({
      sequence,
      monotonicEpochMs,
      byteLength: bytes.byteLength,
      durationUs: Number(payload.duration_us ?? 0),
    });
    if (accepted.status === "duplicate") return accepted;
    if (!sink.file) throw new Error("recording audio sink is closed");
    try {
      const write = await sink.file.write(bytes);
      if (write.bytesWritten !== bytes.byteLength) {
        throw new Error("recording audio chunk was only partially written");
      }
      await sink.file.sync();
      return runtime.audio.acknowledgeChunk(sequence);
    } catch (error) {
      runtime.audio.abort({
        sequence: sequence + 1,
        monotonicEpochMs: Math.max(monotonicEpochMs, recordingMonotonicEpochMs()),
        reason: "audio_stream_aborted",
      });
      await closeRecordingAudioSink(id).catch(() => undefined);
      runtime.markAudioTerminal();
      sendRecordingAudioWarning(session, "audio_stream_aborted");
      throw error;
    }
  }
  if (operation === "pause" || operation === "resume") {
    return runtime.audio[operation]({ sequence, monotonicEpochMs });
  }
  if (operation === "end") {
    const ack = runtime.audio.end({
      sequence,
      monotonicEpochMs,
      totalBytes: Number(payload.total_bytes),
      totalChunks: Number(payload.total_chunks),
    });
    await sink.file?.sync();
    await closeRecordingAudioSink(id);
    runtime.markAudioTerminal();
    return ack;
  }
  if (operation === "abort") {
    const rawReason = String(payload.reason ?? "");
    const ack = runtime.audio.abort({
      sequence,
      monotonicEpochMs,
      reason: rawReason.includes("backpressure")
        ? "audio_backpressure_overflow"
        : "audio_stream_aborted",
    });
    await closeRecordingAudioSink(id).catch(() => undefined);
    runtime.markAudioTerminal();
    sendRecordingAudioWarning(session, rawReason || "audio_stream_aborted");
    return ack;
  }
  throw new Error(`unsupported recording audio stream operation ${operation}`);
}

export function recordingAudioStream(raw: unknown): Promise<RecordingAudioOperationAck> {
  const id = recordingAudioSessionId(raw);
  const previous = recordingAudioOperationTails.get(id) ?? Promise.resolve();
  const task = previous.then(() => processRecordingAudioStream(raw));
  recordingAudioOperationTails.set(
    id,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

export async function setRecordingAudio(raw: unknown): Promise<null> {
  const payload = raw as { session?: { id?: unknown }; id?: unknown; bytes?: unknown } | undefined;
  const id = String(payload?.session?.id ?? payload?.id ?? "");
  const bytes = payload?.bytes;
  const buffer = recordingAudioBytes(bytes);
  if (!buffer || buffer.byteLength === 0) return null;
  const runtime = recordingAvSessions.get(id);
  if (!runtime) return null;
  const captureId = `legacy-${id}`;
  const startAtMs = runtime.registeredMonotonicEpochMs;
  const endAtMs = Math.max(startAtMs, recordingMonotonicEpochMs());
  await recordingAudioStream({
    version: 1,
    operation: "begin",
    session: { id },
    audio_capture_id: captureId,
    sequence: 0,
    monotonic_epoch_ms: startAtMs,
    mime_type: "audio/webm",
  });
  await recordingAudioStream({
    version: 1,
    operation: "chunk",
    session: { id },
    audio_capture_id: captureId,
    sequence: 1,
    monotonic_epoch_ms: endAtMs,
    duration_us: Math.round((endAtMs - startAtMs) * 1_000),
    bytes: buffer,
  });
  await recordingAudioStream({
    version: 1,
    operation: "end",
    session: { id },
    audio_capture_id: captureId,
    sequence: 2,
    monotonic_epoch_ms: endAtMs,
    total_bytes: buffer.byteLength,
    total_chunks: 1,
  });
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

function sendRecordingAudioControl(
  session: RecordingSession,
  action: "pause" | "resume" | "flush_and_end",
  monotonicEpochMs: number,
): void {
  if (session.eventTarget.isDestroyed?.()) return;
  session.eventTarget.send("recording-audio-control", {
    session_id: session.id,
    action,
    monotonic_epoch_ms: monotonicEpochMs,
  });
}

async function requestRecordingAudioDrain(
  session: RecordingSession,
  mode: ReturnType<typeof recordingAvMode>,
): Promise<Readonly<RecordingAudioStreamSnapshot> | null> {
  const runtime = recordingAvSessions.require(session.id);
  const multitrackDescriptors = recordingAudioTracks.descriptors(session.id);
  if (!runtime.audioRequested && multitrackDescriptors.length === 0) return null;
  sendRecordingAudioControl(session, "flush_and_end", recordingMonotonicEpochMs());
  if (!runtime.audioRequested) {
    const deadline = recordingMonotonicEpochMs() + RECORDING_AUDIO_DRAIN_TIMEOUT_MS;
    while (recordingMonotonicEpochMs() < deadline) {
      const descriptors = recordingAudioTracks.descriptors(session.id);
      if (descriptors.every((track) => track.status === "completed" || track.status === "failed")) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }
  if (mode === "legacy") {
    if (session.audioPath) return runtime.audio.snapshot();
    const deadline = recordingMonotonicEpochMs() + RECORDING_AUDIO_DRAIN_TIMEOUT_MS;
    while (recordingMonotonicEpochMs() < deadline) {
      const snapshot = runtime.audio.snapshot();
      if (
        session.audioPath ||
        snapshot.state === "ended" ||
        snapshot.state === "aborted" ||
        snapshot.state === "failed"
      ) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return runtime.audio.snapshot();
  }
  return runtime.waitForAudioTerminal(RECORDING_AUDIO_DRAIN_TIMEOUT_MS);
}

async function buildRecordingCompatibilityMix(
  session: RecordingSession,
  videoDurationUs: number,
): Promise<string | null> {
  if (recordingAudioMode() === "legacy") return null;
  const descriptors = recordingAudioTracks
    .descriptors(session.id)
    .filter((track) => track.status === "completed" && track.relative_path);
  if (descriptors.length === 0) return null;
  const inputs = descriptors.flatMap((descriptor) => {
    const sink = recordingAudioSinks.get(`${session.id}:${descriptor.track_id}`);
    return sink ? [{ descriptor, sink }] : [];
  });
  if (inputs.length === 0) return null;
  const bundle = recordingBundleForSession(session.id);
  const outputPath = bundle
    ? path.join(bundle.allocation.audioDir, "compatibility.m4a")
    : path.join(session.framesDir, "compatibility.m4a");
  const args = recordingCompatibilityMixArgs({
    stems: inputs.map((input) => ({
      path: input.sink.path,
      firstPtsUs: input.descriptor.first_pts_us,
    })),
    outputPath,
    videoDurationUs,
  });
  await fs.rm(outputPath, { force: true });
  await runFfmpeg(args);
  return outputPath;
}

async function selectLegacyRecordingOutput(
  session: RecordingSession,
  videoDurationUs: number,
): Promise<void> {
  const runtime = recordingAvSessions.require(session.id);
  if (runtime.videoOnlyPath === session.outputPath) return;
  const audioStat = session.audioPath ? await fs.stat(session.audioPath).catch(() => null) : null;
  if (session.audioPath && audioStat?.isFile() && audioStat.size > 0) {
    await fs.rm(session.outputPath, { force: true });
    await runFfmpeg([
      ...buildLegacyRecordingAvMuxArgs({
        videoDurationUs,
        videoInputPath: runtime.videoOnlyPath,
        audioInputPath: session.audioPath,
        outputPath: session.outputPath,
      }),
    ]);
    return;
  }
  await fs.rm(session.outputPath, { force: true });
  await fs.rename(runtime.videoOnlyPath, session.outputPath);
}

async function finalizeRecordingAvOutput(
  session: RecordingSession,
  videoEndPtsUs: number,
  audioStream: Readonly<RecordingAudioStreamSnapshot> | null,
  mode: ReturnType<typeof recordingAvMode>,
): Promise<Readonly<RecordingAvSnapshot>> {
  const runtime = recordingAvSessions.require(session.id);
  const finalizedAtMs = recordingMonotonicEpochMs();
  const audioStat = session.audioPath ? await fs.stat(session.audioPath).catch(() => null) : null;
  const audioReadable = Boolean(audioStat?.isFile() && audioStat.size > 0);
  let muxSucceeded = false;
  let muxValidated = false;
  let explicitVideoDurationBounded = false;
  const muxOutputPath = `${session.outputPath}.muxing.mp4`;
  if (mode === "legacy") {
    const selectedProbe = await probeRecording(session.outputPath);
    muxSucceeded = !runtime.audioRequested || audioReadable;
    muxValidated = selectedProbe.status === "valid";
    explicitVideoDurationBounded = true;
  } else if (
    runtime.audioRequested &&
    audioStream?.final_drain_complete &&
    session.audioPath &&
    audioReadable
  ) {
    try {
      const alignment = runtime.clock.alignment({
        audioStream,
        finalizedMonotonicEpochMs: finalizedAtMs,
        videoEndPtsUs,
      });
      const muxPlan = buildRecordingAvMuxPlan({
        alignment,
        audio: audioStream,
        videoInputPath: runtime.videoOnlyPath,
        audioInputPath: session.audioPath,
        outputPath: muxOutputPath,
      });
      explicitVideoDurationBounded = muxPlan.duration_us === alignment.video_duration_us;
      await fs.rm(muxOutputPath, { force: true });
      await runFfmpeg([...muxPlan.args]);
      muxSucceeded = true;
      const muxProbe = await probeRecording(muxOutputPath);
      muxValidated = muxProbe.status === "valid";
      if (muxValidated && mode === "unified") {
        await fs.rename(muxOutputPath, session.outputPath);
        if (runtime.videoOnlyPath !== session.outputPath) {
          await fs.rm(runtime.videoOnlyPath, { force: true });
        }
      }
    } catch (error) {
      void hostLog("warn", "recording_audio_mux_failed", {
        session_id: session.id,
        error_name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  const outputExists = await fs.stat(session.outputPath).catch(() => null);
  if (
    mode === "unified" &&
    !outputExists?.isFile() &&
    runtime.videoOnlyPath !== session.outputPath
  ) {
    await fs.rm(muxOutputPath, { force: true });
    await fs.rename(runtime.videoOnlyPath, session.outputPath);
  }
  if (mode === "shadow") await fs.rm(muxOutputPath, { force: true });
  if (mode !== "unified" && runtime.videoOnlyPath !== session.outputPath) {
    await fs.rm(runtime.videoOnlyPath, { force: true });
  }
  return runtime.clock.finalize({
    audioStream: runtime.audioRequested ? (audioStream ?? runtime.audio.snapshot()) : null,
    finalizedMonotonicEpochMs: finalizedAtMs,
    videoEndPtsUs,
    audioReadable: runtime.audioRequested ? audioReadable : true,
    muxSucceeded: runtime.audioRequested ? muxSucceeded : true,
    muxValidated: runtime.audioRequested ? muxValidated : true,
    explicitVideoDurationBounded: runtime.audioRequested ? explicitVideoDurationBounded : true,
  });
}

function bundleRelativePath(root: string, filePath: string): string | null {
  const relative = path.relative(root, filePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

async function repairAssemblyAudioSources(
  session: RecordingSession,
  bundle: RecordingBundleWriter,
  descriptors: readonly RecordingAudioTrackDescriptor[],
  audioRequested: boolean,
): Promise<RecordingAssemblyAudioSource[]> {
  if (descriptors.length > 0) {
    return Promise.all(
      descriptors.map(async (descriptor) => {
        const relativePath =
          descriptor.status === "completed" && descriptor.relative_path
            ? descriptor.relative_path
            : null;
        const absolutePath = relativePath
          ? path.join(bundle.allocation.stagingRoot, relativePath)
          : null;
        const readable = absolutePath
          ? (await fs.stat(absolutePath).catch(() => null))?.isFile() === true
          : false;
        return {
          role: descriptor.role,
          requirement: descriptor.requirement,
          media_path: readable ? relativePath : null,
          media_sha256:
            readable && absolutePath ? await recordingAssemblyInputSha256(absolutePath) : null,
          first_pts_us: Math.max(0, descriptor.first_pts_us ?? 0),
        };
      }),
    );
  }
  if (!audioRequested) return [];
  const relativePath = session.audioPath
    ? bundleRelativePath(bundle.allocation.stagingRoot, session.audioPath)
    : null;
  const absolutePath = relativePath ? path.join(bundle.allocation.stagingRoot, relativePath) : null;
  const readable = absolutePath
    ? (await fs.stat(absolutePath).catch(() => null))?.isFile() === true
    : false;
  return [
    {
      role: "microphone",
      requirement: "required",
      media_path: readable ? relativePath : null,
      media_sha256:
        readable && absolutePath ? await recordingAssemblyInputSha256(absolutePath) : null,
      first_pts_us: 0,
    },
  ];
}

async function assembleSuccessfulLiveRepair(
  session: RecordingSession,
  bundle: RecordingBundleWriter,
  descriptors: readonly RecordingAudioTrackDescriptor[],
  audioRequested: boolean,
  intent: StopIntent,
): Promise<{ revision: RecordingRevision; durationUs: number; frameCount: number } | null> {
  if (recordingRepairMode() !== "manual_hybrid") return null;
  if (
    intent.kind !== "complete" ||
    intent.automation?.exit_reason !== "completed" ||
    intent.automation.failed !== 0
  ) {
    return null;
  }
  const coordinator = recordingCheckpointsForSession(session.id);
  if (!coordinator) return null;
  const audioSources = await repairAssemblyAudioSources(
    session,
    bundle,
    descriptors,
    audioRequested,
  );
  const prepared = await prepareLiveRepairAssembly({
    takeRoot: bundle.allocation.stagingRoot,
    sourceTakeId: bundle.allocation.takeId,
    snapshot: coordinator.assemblySnapshot(),
    output: {
      width: session.width,
      height: session.height,
      fps: session.fps,
      video_codec: "h264",
      pixel_format: "yuv420p",
      audio_codec: "aac",
      audio_sample_rate: 48_000,
      audio_channel_layout: "stereo",
    },
    captureBackend: session.captureBackend?.selected_backend_id ?? "electron_legacy",
    audioSources,
    toolchain: { ffmpeg: ffmpegPath ? path.basename(ffmpegPath) : "unavailable" },
  });
  if (!prepared) return null;
  const revision = await assembleRecordingSegments({
    takeRoot: bundle.allocation.stagingRoot,
    spec: prepared.spec,
    actionsByAttempt: prepared.actionsByAttempt,
    checkpointsByAttempt: prepared.checkpointsByAttempt,
  });
  const revisionMediaPath = path.join(bundle.allocation.stagingRoot, revision.output_path);
  const originalSessionPath = path.join(
    bundle.allocation.stagingRoot,
    "media",
    "original-session.mp4",
  );
  const replacementPath = `${session.outputPath}.repair-replacement`;
  await fs.copyFile(session.outputPath, originalSessionPath);
  try {
    await fs.copyFile(revisionMediaPath, replacementPath);
    await fs.rename(replacementPath, session.outputPath);
  } catch (error) {
    await fs.rm(replacementPath, { force: true });
    throw error;
  }
  const durationUs = revision.offset_map.reduce((total, offset) => total + offset.duration_us, 0);
  const frameCount = Math.max(1, Math.round((durationUs * session.fps) / 1_000_000));
  if (revision.actions_path) {
    const events = JSON.parse(
      await fs.readFile(path.join(bundle.allocation.stagingRoot, revision.actions_path), "utf8"),
    );
    const currentClock = session.mediaClock.snapshot();
    await writeActionsSidecarAtomic(
      actionsSidecarPath(session.outputPath),
      recordingActionsFromSession(session, events, {
        version: 3,
        frameCount,
        mediaClock: {
          ...currentClock,
          frameCount,
          durationUs,
          nextFrameIndex: frameCount,
          nextPtsUs: durationUs,
        },
      }),
    );
  }
  bundle.registerArtifact("diagnostic", "media/original-session.mp4", false);
  bundle.registerArtifact("video", revision.output_path, false);
  bundle.registerArtifact("diagnostic", `revisions/${revision.revision_id}/assembly.json`, false);
  bundle.registerArtifact("diagnostic", `revisions/${revision.revision_id}/revision.json`, false);
  bundle.registerArtifact("diagnostic", "revisions/current.json", false);
  if (revision.actions_path) bundle.registerArtifact("actions", revision.actions_path, false);
  if (revision.checkpoints_path) {
    bundle.registerArtifact("diagnostic", revision.checkpoints_path, false);
  }
  for (const audioPath of Object.values(revision.audio_paths)) {
    bundle.registerArtifact("audio", audioPath, false);
  }
  if (revision.compatibility_audio_path) {
    bundle.registerArtifact("audio", revision.compatibility_audio_path, false);
  }
  return { revision, durationUs, frameCount };
}

export async function finalizeRecordingSession(session: RecordingSession, intent: StopIntent) {
  const bundle = recordingBundleForSession(session.id);
  const readiness = recordingReadiness.get(session.id);
  const avRuntime = recordingAvSessions.require(session.id);
  const avMode = recordingAvMode();
  const audioMode = recordingAudioMode();
  let tailFrameCommitted = false;
  let tailBarrier: RecordingReadinessResultV1 | null = null;
  const encodedFramesBeforeTail = readiness?.snapshot().encoded_frames ?? session.frameSeq;
  if (bundle) await recordingSessionJournal.checkpoint(session.id, "stop_requested");
  clearInterval(session.heartbeat);
  if (session.captureTimer) clearInterval(session.captureTimer);
  if (intent.kind === "cancel") {
    readiness?.cancel();
  } else {
    if (session.paused) {
      const resumedAtMs = recordingMonotonicEpochMs();
      session.paused = false;
      session.mediaClock.resume();
      readiness?.resume();
      avRuntime.resume(resumedAtMs);
      sendRecordingAudioControl(session, "resume", resumedAtMs);
    }
    tailBarrier =
      (await readiness?.request({
        barrier: "tail_frame_committed",
        budgetMs: recordingFrameCommitBudgetMs(session),
        requestedMediaUs: session.mediaClock.snapshot().nextPtsUs,
        queueFrame: () => queueRecordingFrame(session),
      })) ?? null;
    tailFrameCommitted = tailBarrier?.status === "committed";
  }
  if (session.captureInFlight) await session.captureInFlight;
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
  const audioDrainPromise = requestRecordingAudioDrain(session, avMode);
  session.pauseGate.cancel();
  session.actionLandmarks.cancelAll();
  if (session.frameSeq === 0) {
    try {
      await queueRecordingFrame(session);
    } catch {
      // The common no-frame error below is clearer for callers.
    }
  }
  if (!session.streaming && session.frameSeq === 0) {
    await fs.rm(session.framesDir, { recursive: true, force: true });
    session.ffmpegProcess?.kill("SIGKILL");
    throw new Error("recording stopped before any capture frames were written");
  }

  const wallDurationSec = Math.max(1, (Date.now() - session.startedAt) / 1000);
  if (session.streaming) {
    try {
      if (session.ffmpegProcess?.stdin && !session.ffmpegProcess.stdin.destroyed) {
        session.ffmpegProcess.stdin.end();
      }
      if (session.ffmpegDone) await session.ffmpegDone;
      const expectedTargetLoss =
        session.captureBackend?.terminal_status === "target_lost" &&
        session.encoderError?.name === "CaptureTargetLostError";
      if (session.encoderError && !expectedTargetLoss) throw session.encoderError;
      await recordEngineLog({
        event: "recording.encoder.exited",
        context: {
          session_id: session.id,
          backend_id: session.captureBackend?.selected_backend_id,
          phase: "finalize",
        },
        details: {
          success: true,
          capture_path: "raw_bgra",
          frames_written: session.frameSeq,
          frames_dropped: session.framesDropped,
          skipped_ticks: session.skippedTicks,
          encoder_backpressure_events: session.encoderBackpressureEvents,
        },
      });
    } catch (error) {
      await recordEngineLog({
        level: "error",
        event: "recording.encoder.exited",
        context: {
          session_id: session.id,
          backend_id: session.captureBackend?.selected_backend_id,
          phase: "finalize",
          reason_code: "encode_failed",
        },
        details: {
          success: false,
          capture_path: "raw_bgra",
          frames_written: session.frameSeq,
          encoder_backpressure_events: session.encoderBackpressureEvents,
        },
        error,
      });
      throw error;
    }
    if (!tailFrameCommitted && readiness) {
      tailFrameCommitted = readiness.snapshot().encoded_frames > encodedFramesBeforeTail;
    }
    if (!tailFrameCommitted && readiness?.mode === "enforce" && tailBarrier?.status === "failed") {
      const snapshot = readiness.snapshot();
      throw new RecordingReadinessError({
        ...tailBarrier,
        submitted_frames: snapshot.submitted_frames,
        encoded_frames: snapshot.encoded_frames,
      });
    }
    if (session.frameSeq === 0) {
      throw new Error("recording stopped before any frames were acknowledged by the encoder");
    }
  } else {
    const ffmpegArgs = [
      "-y",
      ...recordingPngSequenceInputArgs(session.effectiveFps),
      "-i",
      path.join(session.framesDir, "frame-%06d.png"),
    ];
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
    ffmpegArgs.push("-an");
    ffmpegArgs.push(
      "-c:v",
      "libx264",
      ...recordingQualityArgs(session.qualityPreset),
      "-movflags",
      "+faststart",
      avRuntime.videoOnlyPath,
    );
    try {
      await runFfmpeg(ffmpegArgs);
      await recordEngineLog({
        event: "recording.encoder.exited",
        context: {
          session_id: session.id,
          backend_id: session.captureBackend?.selected_backend_id,
          phase: "finalize",
        },
        details: {
          success: true,
          capture_path: "png",
          frames_written: session.frameSeq,
          frames_dropped: session.framesDropped,
          skipped_ticks: session.skippedTicks,
        },
      });
    } catch (error) {
      await recordEngineLog({
        level: "error",
        event: "recording.encoder.exited",
        context: {
          session_id: session.id,
          backend_id: session.captureBackend?.selected_backend_id,
          phase: "finalize",
          reason_code: "encode_failed",
        },
        details: {
          success: false,
          capture_path: "png",
          frames_written: session.frameSeq,
        },
        error,
      });
      throw error;
    }
    const health = recordingHealth.get(session.id);
    for (let frameIndex = 0; frameIndex < session.frameSeq; frameIndex += 1) {
      const ptsUs = recordingFramePtsUs(frameIndex, {
        fpsNum: session.effectiveFps,
        fpsDen: 1,
      });
      health?.recordSinkAck({
        frameIndex,
        ptsUs,
      });
      avRuntime.observeEncodedVideoFrame({
        ptsUs,
        monotonicEpochMs: avRuntime.registeredMonotonicEpochMs + ptsUs / 1_000,
      });
    }
  }
  const mediaClock = session.mediaClock.freeze();
  const audioStream = await audioDrainPromise;
  let compatibilityMixPath: string | null = null;
  try {
    compatibilityMixPath = await buildRecordingCompatibilityMix(session, mediaClock.durationUs);
    if (compatibilityMixPath && audioMode !== "multitrack_shadow" && audioMode !== "legacy") {
      session.audioPath = compatibilityMixPath;
    }
  } catch (error) {
    void hostLog("warn", "recording_audio_compatibility_mix_failed", {
      session_id: session.id,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
  }
  if (avMode !== "unified") {
    await selectLegacyRecordingOutput(session, mediaClock.durationUs);
  }
  const av = await finalizeRecordingAvOutput(session, mediaClock.durationUs, audioStream, avMode);
  const audioDescriptors = recordingAudioTracks.descriptors(session.id);
  const repairedAssembly = bundle
    ? await assembleSuccessfulLiveRepair(
        session,
        bundle,
        audioDescriptors,
        avRuntime.audioRequested,
        intent,
      )
    : null;
  const finalizedDurationUs = repairedAssembly?.durationUs ?? mediaClock.durationUs;
  const finalizedFrameCount = repairedAssembly?.frameCount ?? mediaClock.frameCount;
  await fs.rm(session.framesDir, { recursive: true, force: true });
  const stat = await fs.stat(session.outputPath);
  const probe = await probeRecording(session.outputPath);
  const healthAccumulator = recordingHealth.get(session.id);
  healthAccumulator?.recordOutputProbe({
    readable: probe.status === "valid",
    videoFrameCount: probe.status === "valid" ? mediaClock.frameCount : null,
  });
  const finalHealth =
    healthAccumulator?.seal({
      activeMediaMs: recordingCaptureActiveMediaMs(session),
      encoderSucceeded: true,
    }) ?? null;
  const encodedFps = mediaClock.fpsNum / mediaClock.fpsDen;
  const sourceFramesReceived = session.streaming ? session.sourceFramesReceived : session.frameSeq;
  const sourceFps = sourceFramesReceived / wallDurationSec;
  const actualCaptureFps =
    finalHealth?.observed_fps ?? (session.streaming ? sourceFps : encodedFps);
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
  if (session.captureBackend) {
    session.captureBackend = {
      ...session.captureBackend,
      terminal_status:
        session.captureBackend.terminal_status === "target_lost"
          ? "target_lost"
          : intent.kind === "cancel"
            ? "aborted"
            : "stopped",
    };
    void recordEngineLog({
      event: "recording.backend.stopped",
      level: session.captureBackend.terminal_status === "target_lost" ? "warn" : "info",
      context: {
        session_id: session.id,
        backend_id: session.captureBackend.selected_backend_id,
        phase: "finalize",
        reason_code: session.captureBackend.target_loss_reason ?? undefined,
      },
      details: {
        terminal_status: session.captureBackend.terminal_status,
        last_pts_us: session.captureBackendLastPtsUs ?? null,
      },
    });
  }
  const result = {
    output_path: session.outputPath,
    duration_ms: Math.round(finalizedDurationUs / 1000),
    frame_count: finalizedFrameCount,
    duration_us: finalizedDurationUs,
    media_clock: {
      clock: mediaClock.clock,
      unit: mediaClock.unit,
      fps_num: mediaClock.fpsNum,
      fps_den: mediaClock.fpsDen,
      origin_frame: mediaClock.originFrame,
      frame_count: finalizedFrameCount,
      duration_us: finalizedDurationUs,
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
    health: finalHealth,
    av,
    capture_backend: session.captureBackend ?? null,
    recording_revision: repairedAssembly?.revision ?? null,
    terminal_outcome: null as RecordingOutcomeV1 | null,
    shadow_terminal_outcome: null as RecordingOutcomeV1 | null,
    canonical_bundle_committed: false,
    bundle_path: null as string | null,
  };
  const audioRequirement = audioDescriptors.some((track) => track.requirement === "required")
    ? ("required" as const)
    : audioDescriptors.length > 0 || avRuntime.audioRequested
      ? ("optional" as const)
      : ("none" as const);
  const multitrackFailed = audioDescriptors.some(
    (track) => track.status !== "completed" && track.status !== "not_requested",
  );
  const audioAvVerdict = multitrackFailed
    ? audioRequirement === "required"
      ? ("fail" as const)
      : ("degraded" as const)
    : av.outcome.verdict;
  const classifyTerminalCandidates = (
    terminalIntent: ReturnType<typeof recordingLifecycle.sealIntent>,
    outputPath: string,
    canonicalBundleAllocated: boolean,
  ) => {
    const automation =
      terminalIntent.kind === "complete" && terminalIntent.automation
        ? terminalIntent.automation
        : {
            exit_reason:
              terminalIntent.kind === "cancel" ? ("cancelled" as const) : ("completed" as const),
            total_steps: 0,
            succeeded: 0,
            failed: 0,
            failed_ordinal: null,
          };
    const captureEvidence = {
      output_path: outputPath,
      frames_written: result.frames_written,
      frames_dropped: result.frames_dropped,
      cadence_warning: result.cadence_warning,
      finalized: true,
    };
    const legacy = classifyRecordingOutcome({
      session_id: session.id,
      automation,
      capture: captureEvidence,
      artifact_readable: result.bytes > 0,
      cancelled_by: terminalIntent.kind === "cancel" ? terminalIntent.actor : null,
    });
    const readinessSnapshot = readiness?.snapshot() ?? null;
    const strict = classifyStrictRecordingOutcome({
      terminal_evidence_version: 1,
      session_id: session.id,
      automation,
      capture: captureEvidence,
      artifact_readable: result.bytes > 0,
      cancelled_by: terminalIntent.kind === "cancel" ? terminalIntent.actor : null,
      terminal_reason_code:
        session.captureBackend?.terminal_status === "target_lost" ? "capture_target_lost" : null,
      preflight_verdict: acceptedRecordingPreflights.get(session.id)?.verdict ?? null,
      readiness: readinessSnapshot
        ? {
            source_ready: readinessSnapshot.source_ready,
            encoded_frames: readinessSnapshot.encoded_frames,
            tail_committed: tailFrameCommitted,
          }
        : null,
      health_verdict: finalHealth?.verdict ?? null,
      av_verdict: audioAvVerdict,
      audio_requirement: audioRequirement,
      canonical_bundle_allocated: canonicalBundleAllocated,
      recovery_salvaged: false,
    });
    return { legacy, strict };
  };
  const emitShadowOutcome = (legacy: RecordingOutcomeV1, strict: RecordingOutcomeV1) => {
    sendChannel(session.eventTarget, session.eventChannelId, {
      type: "recording_outcome_shadow",
      outcome: strict,
    });
    if (strict.verdict !== legacy.verdict || strict.reason_code !== legacy.reason_code) {
      void hostLog("warn", "recording_outcome_shadow_mismatch", {
        session_id: session.id,
        legacy_verdict: legacy.verdict,
        strict_verdict: strict.verdict,
        strict_reason_code: strict.reason_code,
      });
    }
  };
  const mode = recordingOutcomeMode();
  if (bundle) {
    const actionsPath = actionsSidecarPath(session.outputPath);
    const actionsExist = await fs.stat(actionsPath).catch(() => null);
    if (!actionsExist?.isFile()) {
      await writeActionsSidecarAtomic(actionsPath, recordingActionsFromSession(session, []));
    }
    const audioDescriptorPath = path.join(bundle.allocation.audioDir, "tracks.json");
    if (audioMode !== "legacy") {
      await writeRecordingAudioDescriptors(audioDescriptorPath, session.id, audioDescriptors);
      bundle.registerArtifact("diagnostic", "audio/tracks.json", false);
      for (const descriptor of audioDescriptors) {
        if (!descriptor.relative_path) continue;
        const absolutePath = path.join(bundle.allocation.stagingRoot, descriptor.relative_path);
        if ((await fs.stat(absolutePath).catch(() => null))?.isFile()) {
          bundle.registerArtifact("audio", descriptor.relative_path, false);
        }
      }
      if (compatibilityMixPath) {
        bundle.registerArtifact("audio", "audio/compatibility.m4a", false);
      }
    }
    await writeJsonAtomic(bundle.allocation.healthPath, {
      ...(finalHealth ?? {
        version: 1,
        session_id: session.id,
        requested_fps: session.requestedFps,
        observed_fps: result.actual_capture_fps,
        frames_written: result.frames_written,
        frames_dropped: result.frames_dropped,
        skipped_ticks: result.skipped_ticks,
        encoder_backpressure_events: result.encoder_backpressure_events,
        cadence_warning: result.cadence_warning,
      }),
      av,
      audio_tracks: audioDescriptors,
      capture_backend: session.captureBackend ?? null,
    });
    if (session.audioPath) {
      const relativeAudioPath = path
        .relative(bundle.allocation.stagingRoot, session.audioPath)
        .split(path.sep)
        .join("/");
      bundle.registerArtifact("audio", relativeAudioPath, false);
    }
    const stepsPath = session.outputPath.replace(/\.[^/.]+$/, ".steps.json");
    if ((await fs.stat(stepsPath).catch(() => null))?.isFile()) {
      bundle.registerArtifact("diagnostic", "media/video.steps.json", false);
    }
    const durableArtifacts: Array<{
      kind: "video" | "audio" | "actions" | "health" | "diagnostic";
      file: string;
    }> = [
      { kind: "video", file: session.outputPath },
      { kind: "actions", file: actionsPath },
      { kind: "health", file: bundle.allocation.healthPath },
    ];
    if (session.audioPath) durableArtifacts.push({ kind: "audio", file: session.audioPath });
    if (audioMode !== "legacy") {
      durableArtifacts.push({ kind: "diagnostic", file: audioDescriptorPath });
      for (const descriptor of audioDescriptors) {
        if (!descriptor.relative_path) continue;
        const absolutePath = path.join(bundle.allocation.stagingRoot, descriptor.relative_path);
        if (
          absolutePath !== session.audioPath &&
          (await fs.stat(absolutePath).catch(() => null))?.isFile()
        ) {
          durableArtifacts.push({ kind: "audio", file: absolutePath });
        }
      }
      if (
        compatibilityMixPath &&
        compatibilityMixPath !== session.audioPath &&
        (await fs.stat(compatibilityMixPath).catch(() => null))?.isFile()
      ) {
        durableArtifacts.push({ kind: "audio", file: compatibilityMixPath });
      }
    }
    if ((await fs.stat(stepsPath).catch(() => null))?.isFile()) {
      durableArtifacts.push({ kind: "diagnostic", file: stepsPath });
    }
    await recordingSessionJournal.checkpoint(session.id, "media_durable", {
      artifacts: durableArtifacts,
      capture: {
        observed_fps: result.actual_capture_fps,
        frames_written: result.frames_written,
        frames_dropped: result.frames_dropped,
      },
    });
    const finalVideoPath = bundle.allocation.finalVideoPath;
    const terminalIntent = recordingLifecycle.sealIntent(session.id, intent);
    const candidates = classifyTerminalCandidates(terminalIntent, finalVideoPath, true);
    if (mode === "shadow") {
      emitShadowOutcome(candidates.legacy, candidates.strict);
      result.shadow_terminal_outcome = candidates.strict;
    }
    const candidate = mode === "strict" ? candidates.strict : candidates.legacy;
    const committed = await bundle.commit({
      outcome: candidate,
      capture: {
        target_kind: session.target.kind,
        width: session.width,
        height: session.height,
        output_width: session.outputWidth,
        output_height: session.outputHeight,
        requested_fps: session.requestedFps,
        observed_fps: result.actual_capture_fps,
      },
    });
    if (!committed.outputPath) {
      throw new Error("recording bundle committed without required video");
    }
    session.outputPath = committed.outputPath;
    result.output_path = recordingBundlePublicVideoPath(committed.outputPath);
    result.bundle_path = bundle.allocation.finalRoot;
    result.terminal_outcome = committed.manifest.outcome;
    result.canonical_bundle_committed = true;
    await recordingSessionJournal.markPublished(session.id);
  } else if (mode === "shadow" || mode === "strict") {
    const terminalIntent = recordingLifecycle.sealIntent(session.id, intent);
    const candidates = classifyTerminalCandidates(terminalIntent, session.outputPath, false);
    if (mode === "shadow") {
      emitShadowOutcome(candidates.legacy, candidates.strict);
      result.shadow_terminal_outcome = candidates.strict;
    } else {
      result.terminal_outcome = candidates.strict;
    }
  }
  if (recordingOutcomeMode() !== "strict") {
    sendChannel(session.eventTarget, session.eventChannelId, {
      type: "completed",
      result,
    });
  }
  return result;
}

async function finalizeRecordingSessionWithCleanup(session: RecordingSession, intent: StopIntent) {
  try {
    return await finalizeRecordingSession(session, intent);
  } finally {
    await disposeRecordingCheckpoints(session.id).catch(() => undefined);
    await closeRecordingAudioSinksForSession(session.id);
    authorPreviewTabGrants.revoke(session.id);
    recordingAudioTracks.remove(session.id);
    recordingAudioOperationTails.delete(session.id);
    recordingAvSessions.remove(session.id);
    acceptedRecordingPreflights.remove(session.id);
    recordingHealth.remove(session.id);
  }
}

function recordingId(raw: unknown): string {
  return typeof raw === "string" ? raw : String((raw as { id?: string } | undefined)?.id ?? "");
}

export async function stopRecording(raw: unknown, intent: StopIntent = { kind: "complete" }) {
  const terminal = await recordingLifecycle.stop(
    recordingId(raw),
    intent,
    finalizeRecordingSessionWithCleanup,
  );
  if (!terminal.legacy_result) {
    throw new Error(terminal.error_message ?? "recording finalization produced no artifact");
  }
  return {
    ...terminal.legacy_result,
    terminal_event: terminal.terminal_event,
  };
}

export async function cancelRecording(raw: unknown) {
  const request = raw as
    | { version?: unknown; session?: { id?: unknown }; request_id?: unknown }
    | undefined;
  if (request?.version !== 1) throw new Error("cancel_recording requires version 1");
  if (typeof request.request_id !== "string" || request.request_id.length === 0) {
    throw new Error("cancel_recording requires request_id");
  }
  const id = String(request.session?.id ?? "");
  const cached = recordingLifecycle.isTerminalOrStopping(id);
  const terminal = await recordingLifecycle.stop(
    id,
    { kind: "cancel", actor: "user" },
    finalizeRecordingSessionWithCleanup,
  );
  return {
    version: 1 as const,
    session_id: id,
    snapshot: terminal.snapshot,
    outcome: terminal.outcome,
    terminal: terminal.terminal_event,
    outcome_mode: terminal.outcome_mode,
    cached,
  };
}

export function getRecordingStatus(raw: unknown): RecordingStatusResultV1 {
  const request = raw as { version?: unknown; session?: { id?: unknown } } | undefined;
  if (request?.version !== 1) throw new Error("get_recording_status requires version 1");
  const id = String(request.session?.id ?? "");
  const status = recordingLifecycle.status(id);
  if (!status) throw new Error(`recording session ${id} not found`);
  return status;
}

export async function pauseRecording(raw: unknown) {
  const id = recordingId(raw);
  const snapshot = await recordingLifecycle.pause(id);
  const atMs = recordingMonotonicEpochMs();
  recordingAvSessions.require(id).pause(atMs);
  const session = recordingSessions.get(id);
  if (session) sendRecordingAudioControl(session, "pause", atMs);
  return snapshot;
}

export async function resumeRecording(raw: unknown) {
  const id = recordingId(raw);
  const snapshot = await recordingLifecycle.resume(id);
  const atMs = recordingMonotonicEpochMs();
  recordingAvSessions.require(id).resume(atMs);
  const session = recordingSessions.get(id);
  if (session) sendRecordingAudioControl(session, "resume", atMs);
  return snapshot;
}

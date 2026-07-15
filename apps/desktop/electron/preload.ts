import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextBridge, ipcRenderer } from "electron";
import {
  createRecordingAudioTrackRequest,
  type RecordingAudioTrackRequest,
  recordingAudioMode,
} from "./ipc/audio-tracks";
import { recordingAvMode } from "./ipc/recording-av-clock";
import { convertLocalAssetPath, LOCAL_ASSET_PROTOCOL } from "./local-asset-url";

type Callback = (...args: unknown[]) => void;

const callbacks = new Map<number, { callback?: Callback; once: boolean }>();
const micSessions = new Map<string, MicSession | LegacyMicSession>();
let nextCallbackId = 1;

interface RecordingSessionId {
  id: string;
}

interface MicSession {
  transport: "streaming";
  audioCaptureId: string;
  trackId: string;
  role: "microphone" | "tab";
  sourceId: string | null;
  recorder: MediaRecorder;
  stream: MediaStream;
  mimeType: string;
  sessionId: string | null;
  sequence: number;
  totalBytes: number;
  totalChunks: number;
  outstandingChunks: number;
  outstandingBytes: number;
  pending: MicChunk[];
  operationChain: Promise<void>;
  stopped: boolean;
  stopRequested: boolean;
  failureReason: string | null;
  finishing: Promise<void> | null;
  terminal: Promise<void>;
  resolveTerminal: () => void;
  options: unknown;
  startedAtMs: number;
  lastChunkAtMs: number;
  nextPtsUs: number;
}

interface LegacyMicSession {
  transport: "legacy";
  audioCaptureId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  done: Promise<Uint8Array | null>;
  resolve: (bytes: Uint8Array | null) => void;
  sessionId: string;
  options: unknown;
  finishing: Promise<void> | null;
}

interface MicChunk {
  blob: Blob;
  monotonicEpochMs: number;
  durationUs: number;
  ptsUs: number;
}

interface RecordingAudioControl {
  session_id?: string;
  action?: "pause" | "resume" | "flush_and_end";
  monotonic_epoch_ms?: number;
}

const MIC_TIMESLICE_MS = 1_000;
const MIC_MAX_OUTSTANDING_CHUNKS = 4;
const MIC_MAX_OUTSTANDING_BYTES = 16 * 1024 * 1024;

function audioSessionKey(sessionId: string, role: "microphone" | "tab" | "legacy"): string {
  return `${sessionId}:${role}`;
}

function audioSessionsForRecording(sessionId: string): Array<MicSession | LegacyMicSession> {
  return [...micSessions.entries()]
    .filter(([key]) => key.startsWith(`${sessionId}:`))
    .map(([, session]) => session);
}

function invokeMain(cmd: string, args?: unknown, options?: unknown) {
  return ipcRenderer.invoke("tauri-invoke", { cmd, args, options });
}

function recorderMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

async function startMicCapture(
  deviceId: string,
  identity = createRecordingAudioTrackRequest({
    role: "microphone",
    requirement: "optional",
    source_id: deviceId,
  }),
): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is unavailable in this Electron renderer");
  }
  const audio = deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const mimeType = recorderMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  let resolveTerminal: () => void = () => {};
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const startedAtMs = performance.timeOrigin + performance.now();
  const session: MicSession = {
    transport: "streaming",
    audioCaptureId: identity.capture_token,
    trackId: identity.track_id,
    role: "microphone",
    sourceId: identity.source_id,
    recorder,
    stream,
    mimeType: recorder.mimeType || mimeType || "audio/webm",
    sessionId: null,
    sequence: 0,
    totalBytes: 0,
    totalChunks: 0,
    outstandingChunks: 0,
    outstandingBytes: 0,
    pending: [],
    operationChain: Promise.resolve(),
    stopped: false,
    stopRequested: false,
    failureReason: null,
    finishing: null,
    terminal,
    resolveTerminal,
    options: null,
    startedAtMs,
    lastChunkAtMs: startedAtMs,
    nextPtsUs: 0,
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0 || session.failureReason) return;
    const atMs = performance.timeOrigin + performance.now();
    const chunk = {
      blob: event.data,
      monotonicEpochMs: atMs,
      durationUs: Math.max(0, Math.round((atMs - session.lastChunkAtMs) * 1_000)),
      ptsUs: session.nextPtsUs,
    };
    session.nextPtsUs += chunk.durationUs;
    session.lastChunkAtMs = atMs;
    if (
      session.outstandingChunks + 1 > MIC_MAX_OUTSTANDING_CHUNKS ||
      session.outstandingBytes + event.data.size > MIC_MAX_OUTSTANDING_BYTES
    ) {
      failMicSession(session, "audio_backpressure_overflow");
      return;
    }
    session.outstandingChunks += 1;
    session.outstandingBytes += event.data.size;
    if (session.sessionId) {
      enqueueMicChunk(session, chunk);
    } else {
      session.pending.push(chunk);
    }
  };
  recorder.onerror = () => {
    failMicSession(session, "microphone_recorder_error");
  };
  recorder.onstop = () => {
    session.stopped = true;
    stopMicTracks(session);
    queueMicrotask(() => void finishMicSession(session));
  };
  recorder.start(MIC_TIMESLICE_MS);
  return session;
}

async function startTabCapture(identity: RecordingAudioTrackRequest): Promise<MicSession> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Author-preview tab audio is unavailable in this Electron renderer");
  }
  const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  displayStream.getVideoTracks().forEach((track) => track.stop());
  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    displayStream.getTracks().forEach((track) => track.stop());
    throw new Error("Author-preview tab audio returned no audio track");
  }
  const stream = new MediaStream(audioTracks);
  const mimeType = recorderMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  let resolveTerminal: () => void = () => {};
  const terminal = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const startedAtMs = performance.timeOrigin + performance.now();
  const session: MicSession = {
    transport: "streaming",
    audioCaptureId: identity.capture_token,
    trackId: identity.track_id,
    role: "tab",
    sourceId: identity.source_id,
    recorder,
    stream,
    mimeType: recorder.mimeType || mimeType || "audio/webm",
    sessionId: null,
    sequence: 0,
    totalBytes: 0,
    totalChunks: 0,
    outstandingChunks: 0,
    outstandingBytes: 0,
    pending: [],
    operationChain: Promise.resolve(),
    stopped: false,
    stopRequested: false,
    failureReason: null,
    finishing: null,
    terminal,
    resolveTerminal,
    options: null,
    startedAtMs,
    lastChunkAtMs: startedAtMs,
    nextPtsUs: 0,
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0 || session.failureReason) return;
    const atMs = performance.timeOrigin + performance.now();
    const durationUs = Math.max(0, Math.round((atMs - session.lastChunkAtMs) * 1_000));
    const chunk = {
      blob: event.data,
      monotonicEpochMs: atMs,
      durationUs,
      ptsUs: session.nextPtsUs,
    };
    session.nextPtsUs += durationUs;
    session.lastChunkAtMs = atMs;
    if (
      session.outstandingChunks + 1 > MIC_MAX_OUTSTANDING_CHUNKS ||
      session.outstandingBytes + event.data.size > MIC_MAX_OUTSTANDING_BYTES
    ) {
      failMicSession(session, "audio_backpressure_overflow");
      return;
    }
    session.outstandingChunks += 1;
    session.outstandingBytes += event.data.size;
    if (session.sessionId) enqueueMicChunk(session, chunk);
    else session.pending.push(chunk);
  };
  recorder.onerror = () => failMicSession(session, "tab_audio_recorder_error");
  recorder.onstop = () => {
    session.stopped = true;
    stopMicTracks(session);
    queueMicrotask(() => void finishMicSession(session));
  };
  recorder.start(MIC_TIMESLICE_MS);
  return session;
}

function legacyAudioCaptureId(sessionId: string): string {
  return `legacy-${sessionId}`;
}

function reportMicUnavailable(
  sessionId: string,
  reason: string,
  options: unknown,
): Promise<unknown> {
  return invokeMain(
    "recording_audio_stream",
    {
      version: 1,
      operation: "abort",
      session: { id: sessionId },
      audio_capture_id: legacyAudioCaptureId(sessionId),
      sequence: 0,
      monotonic_epoch_ms: performance.timeOrigin + performance.now(),
      reason,
    },
    options,
  ).catch(() => null);
}

function reportTrackUnavailable(
  sessionId: string,
  track: RecordingAudioTrackRequest,
  reason: string,
  options: unknown,
): Promise<unknown> {
  return invokeMain(
    "recording_audio_stream",
    {
      version: 1,
      operation: "abort",
      session: { id: sessionId },
      audio_capture_id: track.capture_token,
      capture_token: track.capture_token,
      track_id: track.track_id,
      role: track.role,
      source_id: track.source_id,
      sequence: 0,
      monotonic_epoch_ms: performance.timeOrigin + performance.now(),
      reason,
    },
    options,
  ).catch(() => null);
}

async function startLegacyMicCapture(
  deviceId: string,
  sessionId: string,
  options: unknown,
): Promise<LegacyMicSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is unavailable in this Electron renderer");
  }
  const audio = deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const chunks: Blob[] = [];
  let resolveDone: (bytes: Uint8Array | null) => void = () => {};
  const done = new Promise<Uint8Array | null>((resolve) => {
    resolveDone = resolve;
  });
  const mimeType = recorderMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const session: LegacyMicSession = {
    transport: "legacy",
    audioCaptureId: legacyAudioCaptureId(sessionId),
    recorder,
    stream,
    chunks,
    done,
    resolve: resolveDone,
    sessionId,
    options,
    finishing: null,
  };
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onerror = () => {
    stopMicTracks(session);
    resolveDone(null);
    void reportMicUnavailable(sessionId, "microphone_recorder_error", options);
  };
  recorder.onstop = () => {
    stopMicTracks(session);
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    void blob.arrayBuffer().then(
      (buffer) => resolveDone(new Uint8Array(buffer)),
      () => resolveDone(null),
    );
  };
  recorder.start(250);
  return session;
}

function stopMicTracks(session: Pick<MicSession | LegacyMicSession, "stream">): void {
  session.stream.getTracks().forEach((track) => {
    track.stop();
  });
}

function failMicSession(session: MicSession, reason: string): void {
  if (session.failureReason) return;
  session.failureReason = reason;
  session.pending = [];
  session.outstandingChunks = 0;
  session.outstandingBytes = 0;
  if (session.recorder.state !== "inactive") {
    session.stopRequested = true;
    session.recorder.stop();
  } else {
    session.stopped = true;
    stopMicTracks(session);
    queueMicrotask(() => void finishMicSession(session));
  }
}

function audioStreamPayload(
  session: MicSession,
  operation: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    session: { id: session.sessionId },
    audio_capture_id: session.audioCaptureId,
    capture_token: session.audioCaptureId,
    track_id: session.trackId,
    role: session.role,
    source_id: session.sourceId,
    ...operation,
  };
}

function enqueueMicChunk(session: MicSession, chunk: MicChunk): void {
  session.operationChain = session.operationChain
    .then(async () => {
      if (!session.sessionId || session.failureReason) return;
      const bytes = new Uint8Array(await chunk.blob.arrayBuffer());
      await invokeMain(
        "recording_audio_stream",
        audioStreamPayload(session, {
          operation: "chunk",
          sequence: session.sequence,
          monotonic_epoch_ms: chunk.monotonicEpochMs,
          pts_us: chunk.ptsUs,
          duration_us: chunk.durationUs,
          bytes,
        }),
        session.options,
      );
      session.sequence += 1;
      session.totalBytes += bytes.byteLength;
      session.totalChunks += 1;
    })
    .catch((error) => {
      failMicSession(session, error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      session.outstandingChunks = Math.max(0, session.outstandingChunks - 1);
      session.outstandingBytes = Math.max(0, session.outstandingBytes - chunk.blob.size);
    });
}

async function attachMicSession(
  session: MicSession,
  sessionId: string,
  options: unknown,
): Promise<void> {
  session.sessionId = sessionId;
  session.options = options;
  session.operationChain = session.operationChain
    .then(async () => {
      await invokeMain(
        "recording_audio_stream",
        audioStreamPayload(session, {
          operation: "begin",
          sequence: session.sequence,
          monotonic_epoch_ms: session.startedAtMs,
          mime_type: session.mimeType,
        }),
        session.options,
      );
      session.sequence += 1;
    })
    .catch((error) => {
      failMicSession(session, error instanceof Error ? error.message : String(error));
    });
  const pending = session.pending;
  session.pending = [];
  for (const chunk of pending) enqueueMicChunk(session, chunk);
  await session.operationChain;
  if (session.stopped) await finishMicSession(session);
}

async function enqueueMicControl(
  session: MicSession,
  operation: "pause" | "resume",
  monotonicEpochMs: number,
): Promise<void> {
  if (!session.sessionId || session.failureReason) return;
  session.operationChain = session.operationChain
    .then(async () => {
      await invokeMain(
        "recording_audio_stream",
        audioStreamPayload(session, {
          operation,
          sequence: session.sequence,
          monotonic_epoch_ms: monotonicEpochMs,
        }),
        session.options,
      );
      session.sequence += 1;
    })
    .catch((error) => {
      failMicSession(session, error instanceof Error ? error.message : String(error));
    });
  await session.operationChain;
}

async function finishMicSession(session: MicSession): Promise<void> {
  if (!session.sessionId) return;
  if (session.finishing) return session.finishing;
  session.finishing = (async () => {
    await session.operationChain;
    try {
      if (session.failureReason) {
        await invokeMain(
          "recording_audio_stream",
          audioStreamPayload(session, {
            operation: "abort",
            sequence: session.sequence,
            monotonic_epoch_ms: performance.timeOrigin + performance.now(),
            reason: session.failureReason,
          }),
          session.options,
        );
      } else {
        await invokeMain(
          "recording_audio_stream",
          audioStreamPayload(session, {
            operation: "end",
            sequence: session.sequence,
            monotonic_epoch_ms: performance.timeOrigin + performance.now(),
            total_bytes: session.totalBytes,
            total_chunks: session.totalChunks,
          }),
          session.options,
        );
      }
    } catch {
      // The host owns channel sequencing and will surface any accepted abort.
    } finally {
      session.resolveTerminal();
    }
  })();
  return session.finishing;
}

async function stopStreamingMicCapture(session: MicSession): Promise<void> {
  if (!session.stopRequested && session.recorder.state !== "inactive") {
    session.stopRequested = true;
    session.recorder.stop();
  } else {
    session.stopped = true;
    stopMicTracks(session);
    void finishMicSession(session);
  }
  await session.terminal;
}

async function stopLegacyMicCapture(session: LegacyMicSession): Promise<void> {
  if (session.finishing) return session.finishing;
  session.finishing = (async () => {
    if (session.recorder.state !== "inactive") {
      session.recorder.stop();
    } else {
      stopMicTracks(session);
      session.resolve(null);
    }
    const bytes = await session.done;
    if (!bytes?.byteLength) return;
    try {
      await invokeMain(
        "electron_recording_set_audio",
        { session: { id: session.sessionId }, bytes },
        session.options,
      );
    } catch (error) {
      await reportMicUnavailable(
        session.sessionId,
        error instanceof Error ? error.message : String(error),
        session.options,
      );
    }
  })();
  return session.finishing;
}

async function stopMicCapture(sessionId: string): Promise<void> {
  const sessions = audioSessionsForRecording(sessionId);
  await Promise.all(
    sessions.map((session) =>
      session.transport === "legacy"
        ? stopLegacyMicCapture(session)
        : stopStreamingMicCapture(session),
    ),
  );
  for (const [key] of micSessions) {
    if (key.startsWith(`${sessionId}:`)) micSessions.delete(key);
  }
}

async function handleStartRecording(args?: unknown, options?: unknown): Promise<unknown> {
  const payload = args as
    | {
        args?: {
          audio_device_id?: string | null;
          target?: { kind?: string; stream_id?: string };
          audio_track_selection?: Array<{
            role?: "microphone" | "tab";
            requirement?: "required" | "optional";
            source_id?: string | null;
          }>;
        };
        onEvent?: unknown;
      }
    | undefined;
  const audioDeviceId = payload?.args?.audio_device_id;
  if (recordingAvMode() === "legacy") {
    const result = (await invokeMain("start_recording", args, options)) as RecordingSessionId;
    if (audioDeviceId && result.id) {
      try {
        micSessions.set(
          audioSessionKey(result.id, "legacy"),
          await startLegacyMicCapture(audioDeviceId, result.id, options),
        );
      } catch (error) {
        await reportMicUnavailable(
          result.id,
          error instanceof Error ? error.message : String(error),
          options,
        );
      }
    }
    return result;
  }
  const selections = payload?.args?.audio_track_selection ?? [];
  const trackRequests: RecordingAudioTrackRequest[] = [];
  if (recordingAudioMode() !== "legacy") {
    for (const selection of selections) {
      if (selection.role !== "microphone" && selection.role !== "tab") continue;
      if (selection.requirement !== "required" && selection.requirement !== "optional") continue;
      trackRequests.push(
        createRecordingAudioTrackRequest({
          role: selection.role,
          requirement: selection.requirement,
          source_id: selection.source_id ?? null,
        }),
      );
    }
    if (audioDeviceId && !trackRequests.some((track) => track.role === "microphone")) {
      trackRequests.push(
        createRecordingAudioTrackRequest({
          role: "microphone",
          requirement: "optional",
          source_id: audioDeviceId,
        }),
      );
    }
  }
  const microphoneRequest = trackRequests.find((track) => track.role === "microphone");
  const tabRequest = trackRequests.find((track) => track.role === "tab");
  let mic: MicSession | null = null;
  let startArgs: unknown = args;
  if (audioDeviceId) {
    try {
      mic = await startMicCapture(audioDeviceId, microphoneRequest);
      mic.options = options;
      startArgs = {
        ...payload,
        args: {
          ...payload?.args,
          audio_capture_id: mic.audioCaptureId,
          audio_tracks: trackRequests,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      startArgs = {
        ...payload,
        args: { ...payload?.args, audio_tracks: trackRequests, audio_unavailable_reason: reason },
      };
    }
  } else if (trackRequests.length > 0) {
    startArgs = { ...payload, args: { ...payload?.args, audio_tracks: trackRequests } };
  }
  try {
    const result = (await invokeMain("start_recording", startArgs, options)) as RecordingSessionId;
    if (mic && result.id) {
      micSessions.set(audioSessionKey(result.id, "microphone"), mic);
      await attachMicSession(mic, result.id, options);
    }
    if (tabRequest && result.id) {
      try {
        const tab = await startTabCapture(tabRequest);
        micSessions.set(audioSessionKey(result.id, "tab"), tab);
        await attachMicSession(tab, result.id, options);
      } catch (error) {
        await reportTrackUnavailable(
          result.id,
          tabRequest,
          error instanceof Error ? error.message : String(error),
          options,
        );
      }
    }
    return result;
  } catch (error) {
    if (mic) {
      mic.failureReason = "recording_start_failed";
      if (mic.recorder.state !== "inactive") mic.recorder.stop();
      stopMicTracks(mic);
      mic.resolveTerminal();
    }
    throw error;
  }
}

async function handleStopRecording(args?: unknown, options?: unknown): Promise<unknown> {
  const payload = args as { session?: RecordingSessionId; onEvent?: unknown } | undefined;
  const sessionId = payload?.session?.id;
  if (sessionId) {
    await stopMicCapture(sessionId);
  }
  return invokeMain("stop_recording", args, options);
}

async function handlePauseRecording(args?: unknown, options?: unknown): Promise<unknown> {
  return invokeMain("pause_recording", args, options);
}

async function handleResumeRecording(args?: unknown, options?: unknown): Promise<unknown> {
  return invokeMain("resume_recording", args, options);
}

function handleInvoke(cmd: string, args?: unknown, options?: unknown): Promise<unknown> {
  if (cmd === "start_recording") return handleStartRecording(args, options);
  if (cmd === "stop_recording") return handleStopRecording(args, options);
  if (cmd === "pause_recording") return handlePauseRecording(args, options);
  if (cmd === "resume_recording") return handleResumeRecording(args, options);
  return invokeMain(cmd, args, options);
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function convertFileSrc(filePath: string): string {
  const value = String(filePath);
  if (/^(?:https?:|data:|blob:|asset:)/i.test(value) || value.startsWith(LOCAL_ASSET_PROTOCOL)) {
    return value;
  }
  if (value.startsWith("file:")) {
    return convertLocalAssetPath(fileURLToPath(value));
  }
  if (isAbsoluteLocalPath(value)) {
    return convertLocalAssetPath(value);
  }
  return convertLocalAssetPath(path.resolve(value));
}

const tauriInternals = {
  invoke: handleInvoke,
  transformCallback: (callback?: Callback, once = false) => {
    const id = nextCallbackId++;
    callbacks.set(id, { callback, once });
    return id;
  },
  unregisterCallback: (id: number) => {
    callbacks.delete(id);
  },
  convertFileSrc,
};

const eventInternals = {
  unregisterListener: () => {},
};

const desktopPlatform = process.platform;
const designPlatform = desktopPlatform === "win32" ? "win" : desktopPlatform;

function applyDesktopPlatformDataset(): void {
  const root = document.documentElement;
  if (!root) return;
  root.dataset.desktopPlatform = desktopPlatform;
  root.dataset.platform = designPlatform;
  root.dataset.recordingAudioMode = recordingAudioMode();
}

applyDesktopPlatformDataset();
window.addEventListener("DOMContentLoaded", applyDesktopPlatformDataset, { once: true });

ipcRenderer.on("tauri-callback", (_event, payload: { id: number; value: unknown }) => {
  const entry = callbacks.get(payload.id);
  if (!entry?.callback) return;
  entry.callback(payload.value);
  if (entry.once) callbacks.delete(payload.id);
});

ipcRenderer.on("recording-audio-control", (_event, payload: RecordingAudioControl) => {
  const sessionId = String(payload.session_id ?? "");
  const sessions = audioSessionsForRecording(sessionId);
  if (sessions.length === 0 || !payload.action) return;
  if (payload.action === "flush_and_end") {
    void stopMicCapture(sessionId);
    return;
  }
  for (const session of sessions) {
    if (session.transport === "legacy") {
      if (payload.action === "pause" && session.recorder.state === "recording") {
        session.recorder.pause();
      } else if (payload.action === "resume" && session.recorder.state === "paused") {
        session.recorder.resume();
      }
      continue;
    }
    const atMs = Math.max(
      session.lastChunkAtMs,
      Number(payload.monotonic_epoch_ms) || performance.timeOrigin + performance.now(),
    );
    if (payload.action === "pause") {
      if (session.recorder.state === "recording") session.recorder.pause();
      void enqueueMicControl(session, "pause", atMs);
      continue;
    }
    if (session.recorder.state === "paused") session.recorder.resume();
    void enqueueMicControl(session, "resume", atMs);
  }
});

contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", tauriInternals);
contextBridge.exposeInMainWorld("__TAURI_EVENT_PLUGIN_INTERNALS__", eventInternals);
contextBridge.exposeInMainWorld("__STORYCAPTURE_ELECTRON__", {
  isElectron: true,
});

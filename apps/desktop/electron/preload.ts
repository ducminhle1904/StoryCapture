import { contextBridge, ipcRenderer } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertLocalAssetPath, LOCAL_ASSET_PROTOCOL } from "./local-asset-url";

type Callback = (...args: unknown[]) => void;

const callbacks = new Map<number, { callback?: Callback; once: boolean }>();
const channelIndexes = new Map<number, number>();
const micSessions = new Map<string, MicSession>();
let nextCallbackId = 1;

interface RecordingSessionId {
  id: string;
}

interface MicSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  done: Promise<Uint8Array | null>;
  resolve: (bytes: Uint8Array | null) => void;
}

function invokeMain(cmd: string, args?: unknown, options?: unknown) {
  return ipcRenderer.invoke("tauri-invoke", { cmd, args, options });
}

function channelIdFrom(value: unknown): number | null {
  if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
    const id = Number(value.slice("__CHANNEL__:".length));
    return Number.isFinite(id) ? id : null;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = Number((value as { id?: unknown }).id);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

function sendLocalChannel(channel: unknown, message: unknown): void {
  const id = channelIdFrom(channel);
  if (id == null) return;
  const entry = callbacks.get(id);
  if (!entry?.callback) return;
  const index = channelIndexes.get(id) ?? 0;
  channelIndexes.set(id, index + 1);
  entry.callback({ index, message });
}

function recorderMimeType(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

async function startMicCapture(deviceId: string): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is unavailable in this Electron renderer");
  }
  const audio =
    deviceId && deviceId !== "default"
      ? { deviceId: { exact: deviceId } }
      : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const chunks: Blob[] = [];
  let resolveDone: (bytes: Uint8Array | null) => void = () => {};
  const done = new Promise<Uint8Array | null>((resolve) => {
    resolveDone = resolve;
  });
  const mimeType = recorderMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onerror = () => {
    stream.getTracks().forEach((track) => track.stop());
    resolveDone(null);
  };
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    void blob.arrayBuffer().then((buffer) => resolveDone(new Uint8Array(buffer)), () => resolveDone(null));
  };
  recorder.start(250);
  return { recorder, stream, chunks, done, resolve: resolveDone };
}

async function stopMicCapture(sessionId: string): Promise<Uint8Array | null> {
  const session = micSessions.get(sessionId);
  if (!session) return null;
  micSessions.delete(sessionId);
  if (session.recorder.state !== "inactive") {
    session.recorder.stop();
  } else {
    session.stream.getTracks().forEach((track) => track.stop());
    session.resolve(null);
  }
  return session.done;
}

async function handleStartRecording(args?: unknown, options?: unknown): Promise<unknown> {
  const result = await invokeMain("start_recording", args, options) as RecordingSessionId;
  const payload = args as { args?: { audio_device_id?: string | null }; onEvent?: unknown } | undefined;
  const audioDeviceId = payload?.args?.audio_device_id;
  if (audioDeviceId && result.id) {
    try {
      const mic = await startMicCapture(audioDeviceId);
      micSessions.set(result.id, mic);
    } catch (error) {
      sendLocalChannel(payload?.onEvent, {
        type: "audio-unavailable",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

async function handleStopRecording(args?: unknown, options?: unknown): Promise<unknown> {
  const payload = args as { session?: RecordingSessionId; onEvent?: unknown } | undefined;
  const sessionId = payload?.session?.id;
  if (sessionId) {
    const bytes = await stopMicCapture(sessionId);
    if (bytes?.byteLength) {
      try {
        await invokeMain("electron_recording_set_audio", { session: payload.session, bytes }, options);
      } catch (error) {
        sendLocalChannel(payload?.onEvent, {
          type: "audio-unavailable",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return invokeMain("stop_recording", args, options);
}

async function handlePauseRecording(args?: unknown, options?: unknown): Promise<unknown> {
  const sessionId = (args as { session?: RecordingSessionId } | undefined)?.session?.id;
  const mic = sessionId ? micSessions.get(sessionId) : null;
  if (mic?.recorder.state === "recording") mic.recorder.pause();
  try {
    return await invokeMain("pause_recording", args, options);
  } catch (error) {
    if (mic?.recorder.state === "paused") mic.recorder.resume();
    throw error;
  }
}

async function handleResumeRecording(args?: unknown, options?: unknown): Promise<unknown> {
  const sessionId = (args as { session?: RecordingSessionId } | undefined)?.session?.id;
  const mic = sessionId ? micSessions.get(sessionId) : null;
  if (mic?.recorder.state === "paused") mic.recorder.resume();
  try {
    return await invokeMain("resume_recording", args, options);
  } catch (error) {
    if (mic?.recorder.state === "recording") mic.recorder.pause();
    throw error;
  }
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
}

applyDesktopPlatformDataset();
window.addEventListener("DOMContentLoaded", applyDesktopPlatformDataset, { once: true });

ipcRenderer.on(
  "tauri-callback",
  (_event, payload: { id: number; value: unknown }) => {
    const entry = callbacks.get(payload.id);
    if (!entry?.callback) return;
    entry.callback(payload.value);
    if (entry.once) callbacks.delete(payload.id);
  },
);

contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", tauriInternals);
contextBridge.exposeInMainWorld("__TAURI_EVENT_PLUGIN_INTERNALS__", eventInternals);
contextBridge.exposeInMainWorld("__STORYCAPTURE_ELECTRON__", {
  isElectron: true,
});

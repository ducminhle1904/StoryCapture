import { contextBridge, ipcRenderer } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TauriChannelSequencer } from "./channel-sequence";
import { convertLocalAssetPath, LOCAL_ASSET_PROTOCOL } from "./local-asset-url";

type Callback = (...args: unknown[]) => void;

const callbacks = new Map<number, { callback?: Callback; once: boolean }>();
const channelSequencer = new TauriChannelSequencer();
let nextCallbackId = 1;

function invokeMain(cmd: string, args?: unknown, options?: unknown) {
  return ipcRenderer.invoke("tauri-invoke", { cmd, args, options });
}

function channelIdFrom(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
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
  entry.callback(channelSequencer.message(id, message));
}

function closeLocalChannel(channel: unknown): void {
  const id = channelIdFrom(channel);
  if (id == null) return;
  const entry = callbacks.get(id);
  if (entry?.callback) {
    entry.callback(channelSequencer.end(id));
  } else {
    channelSequencer.forget(id);
  }
  callbacks.delete(id);
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
  invoke: invokeMain,
  transformCallback: (callback?: Callback, once = false) => {
    const id = nextCallbackId++;
    callbacks.set(id, { callback, once });
    return id;
  },
  unregisterCallback: (id: number) => {
    callbacks.delete(id);
    channelSequencer.forget(id);
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
    if (entry.once) {
      callbacks.delete(payload.id);
      channelSequencer.forget(payload.id);
    }
  },
);

ipcRenderer.on(
  "tauri-channel",
  (_event, payload: { id: number; message?: unknown; end?: boolean }) => {
    if (payload.end) {
      closeLocalChannel(payload.id);
      return;
    }
    sendLocalChannel(payload.id, payload.message);
  },
);

contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", tauriInternals);
contextBridge.exposeInMainWorld("__TAURI_EVENT_PLUGIN_INTERNALS__", eventInternals);
contextBridge.exposeInMainWorld("__STORYCAPTURE_ELECTRON__", {
  isElectron: true,
});

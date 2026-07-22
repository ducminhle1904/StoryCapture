import { contextBridge, ipcRenderer } from "electron";

const ALLOWED_COMMANDS = new Set([
  "open_recording_master_decoder",
  "decode_recording_master_frame",
  "close_recording_master_decoder",
]);

function invokeMain(cmd: string, args?: unknown, options?: unknown): Promise<unknown> {
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return Promise.reject(new Error(`Export compositor IPC command is not allowed: ${cmd}`));
  }
  return ipcRenderer.invoke("tauri-invoke", { cmd, args, options });
}

contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", {
  invoke: invokeMain,
});

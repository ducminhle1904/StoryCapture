import { ipcMain } from "electron";
import { handlers } from "./ipc/handlers";
import { handleLegacyInvoke } from "./ipc/legacy";
import { handleInvoke } from "./ipc/router";
import type { InvokeEnvelope } from "./ipc/types";

export function registerIpcHandlers(): void {
  ipcMain.handle("tauri-invoke", async (event, envelope: InvokeEnvelope) => {
    return handleInvoke(event, envelope, handlers, handleLegacyInvoke);
  });
}

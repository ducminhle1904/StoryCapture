import { ipcMain } from "electron";
import { handlers } from "./ipc/handlers";
import { handleLegacyInvoke } from "./ipc/legacy";
import {
  configureRecordingV4PlatformSessionFactory,
  initializeRecordingV4Ipc,
  isRecordingV4DevelopmentRouteEnabled,
} from "./ipc/recording-v4";
import { createDefaultRecordingV4PlatformSessionFactory } from "./ipc/recording-v4-platform-session";
import { handleInvoke } from "./ipc/router";
import type { InvokeEnvelope } from "./ipc/types";

export function registerIpcHandlers(): void {
  if (isRecordingV4DevelopmentRouteEnabled()) {
    void createDefaultRecordingV4PlatformSessionFactory()
      .then((factory) => configureRecordingV4PlatformSessionFactory(factory))
      .then(() => initializeRecordingV4Ipc())
      .catch((error) => {
        console.error("[recording-v4] startup recovery failed", error);
      });
  }
  ipcMain.handle("tauri-invoke", async (event, envelope: InvokeEnvelope) => {
    return handleInvoke(event, envelope, handlers, handleLegacyInvoke);
  });
}

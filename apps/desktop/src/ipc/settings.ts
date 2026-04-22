/**
 * App-settings IPC wrappers. See
 * `apps/desktop/src-tauri/src/commands/app_settings.rs` (and
 * `set_browser_executable` in the browser-preset registration).
 *
 * Keeps the `invoke<AppSettings>("get_app_settings")` call in one
 * place so UI components don't re-describe the IPC shape inline.
 */

import { invoke } from "@tauri-apps/api/core";

export interface AppSettings {
  browser_executable: string | null;
  /** Phase 09-02 — persisted live-preview toggle. */
  live_preview_enabled: boolean;
}

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function setBrowserExecutable(
  path: string | null,
): Promise<AppSettings> {
  return invoke<AppSettings>("set_browser_executable", { path });
}

export function setLivePreviewEnabled(enabled: boolean): Promise<AppSettings> {
  return invoke<AppSettings>("set_live_preview_enabled", { enabled });
}

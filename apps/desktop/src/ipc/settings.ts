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
}

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function setBrowserExecutable(
  path: string | null,
): Promise<AppSettings> {
  return invoke<AppSettings>("set_browser_executable", { path });
}

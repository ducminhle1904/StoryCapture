/**
 * Typed wrappers around the auto-updater Tauri commands.
 *
 * Opt-in: these functions are only called from the Settings UI (or
 * programmatically after the user toggles "check-for-updates-on-launch"
 * on). Nothing here runs on boot.
 */

import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  version: string;
  date: string | null;
  body: string | null;
  current_version: string;
}

export const checkUpdate = (): Promise<UpdateInfo | null> =>
  invoke<UpdateInfo | null>("check_update");

export const installUpdate = (): Promise<void> =>
  invoke<void>("install_update");

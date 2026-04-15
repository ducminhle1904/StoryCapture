/**
 * Capture IPC wrappers (Plan 01-07 commands). See
 * `apps/desktop/src-tauri/src/commands/capture.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

export type PermissionState = "Granted" | "Denied" | "Undetermined";

export interface DisplayInfo {
  id: bigint | number; // specta emits bigint for u64
  name: string;
  width: number;
  height: number;
  scale_factor: number;
}

export function listDisplays(): Promise<DisplayInfo[]> {
  return invoke<DisplayInfo[]>("list_displays");
}

export function checkScreenCapturePermission(): Promise<PermissionState> {
  return invoke<PermissionState>("check_screen_capture_permission");
}

export function openScreenCapturePrefs(): Promise<void> {
  return invoke<void>("open_screen_capture_prefs");
}

export function relaunchApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}

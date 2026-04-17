/**
 * Capture IPC wrappers (Plan 01-07 commands). See
 * `apps/desktop/src-tauri/src/commands/capture.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

// Rust-side DTO uses `#[serde(rename_all = "kebab-case")]`, so values
// arrive as lowercase over IPC. Keep TS in lockstep.
export type PermissionState = "granted" | "denied" | "undetermined";

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

/**
 * Triggers macOS `CGRequestScreenCaptureAccess()`. Registers the app in
 * System Settings → Privacy & Security → Screen Recording so the user
 * can toggle it. Without this call, the app doesn't appear in the list.
 * Call this BEFORE opening Settings.
 */
export function requestScreenCaptureAccess(): Promise<PermissionState> {
  return invoke<PermissionState>("request_screen_capture_access");
}

export function relaunchApp(): Promise<void> {
  return invoke<void>("relaunch_app");
}

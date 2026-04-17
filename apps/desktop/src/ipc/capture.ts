/**
 * Capture IPC wrappers (Plan 01-07 + Plan 05-01 commands). See
 * `apps/desktop/src-tauri/src/commands/capture.rs`.
 */

import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";

// Rust-side DTO uses `#[serde(rename_all = "kebab-case")]`, so values
// arrive as lowercase over IPC. Keep TS in lockstep.
export type PermissionState = "granted" | "denied" | "undetermined";

export interface DisplayInfo {
  id: bigint | number; // specta emits bigint for u64
  name: string;
  width_px: number;
  height_px: number;
  scale_factor: number;
  is_primary: boolean;
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

// ─── Plan 05-01: window-targeted capture ──────────────────────────────

export interface WindowInfo {
  window_id: bigint | number;
  title: string | null;
  app_name: string;
  pid: number;
  bundle_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_on_screen: boolean;
}

export type CaptureTarget =
  | { kind: "display"; display_id: bigint | number }
  | { kind: "window"; window_id: bigint | number }
  | { kind: "window_by_pid"; pid: number; title_hint: string | null };

export interface CaptureTargets {
  displays: DisplayInfo[];
  windows: WindowInfo[];
  playwright_auto_available: boolean;
}

export function listWindows(): Promise<WindowInfo[]> {
  return invoke<WindowInfo[]>("list_windows");
}

export function listCaptureTargets(): Promise<CaptureTargets> {
  return invoke<CaptureTargets>("list_capture_targets");
}

export function getCaptureTarget(): Promise<CaptureTarget | null> {
  return invoke<CaptureTarget | null>("get_capture_target");
}

export function setCaptureTarget(target: CaptureTarget): Promise<void> {
  return invoke<void>("set_capture_target", { target });
}

export interface StartCaptureTargetArgs {
  target: CaptureTarget;
  include_cursor: boolean;
  fps_target: number;
  pixel_format: "bgra" | "nv12";
  queue_cap_bytes?: number;
}

/** Plan 05-01: target-aware start_capture. `Channel` carries capture
 *  events (Started / BackendFailed / WindowCaptureFellBack / etc.) and
 *  per-frame metadata. */
export async function startCaptureTarget(
  args: StartCaptureTargetArgs,
  onEvent: (json: string) => void,
  onFrame: (meta: unknown) => void,
): Promise<{ id: string }> {
  const evtChan = new Channel<{ json: string }>();
  evtChan.onmessage = (payload) => onEvent(payload.json);
  const frameChan = new Channel<unknown>();
  frameChan.onmessage = onFrame;
  return invoke<{ id: string }>("start_capture_target", {
    args,
    onEvent: evtChan,
    onFrame: frameChan,
  });
}

/** Stable key for React <SelectItem> etc. */
export function captureTargetKey(t: CaptureTarget): string {
  switch (t.kind) {
    case "display":
      return `display:${t.display_id}`;
    case "window":
      return `window:${t.window_id}`;
    case "window_by_pid":
      return `pid:${t.pid}:${t.title_hint ?? ""}`;
  }
}

/** The Playwright-auto sentinel. The Rust `start_capture_target` command
 *  rewrites the pid from the host-side Playwright stash at call time
 *  (T-05-02-01 — renderer never supplies a pid directly). */
export const PLAYWRIGHT_AUTO_TARGET: CaptureTarget = {
  kind: "window_by_pid",
  pid: -1,
  title_hint: "storycapture-playwright",
};

// ─── Plan 05-02: Playwright auto-target resolution ────────────────────

export interface ResolvedPlaywrightTarget {
  window_id: bigint | number;
  pid: number;
}

/** Ask the host to resolve the current Playwright window. Returns `null`
 *  when no Playwright is running or the window isn't on-screen. */
export function resolvePlaywrightTarget(): Promise<ResolvedPlaywrightTarget | null> {
  return invoke<ResolvedPlaywrightTarget | null>("resolve_playwright_target");
}

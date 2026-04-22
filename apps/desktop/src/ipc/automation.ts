/**
 * Automation IPC wrappers (Plan 01-06). Thin typed facade for the commands
 * defined in `apps/desktop/src-tauri/src/commands/automation.rs`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Mirror of `automation::BoundingBox` (Phase 10-01 — carried on StepFrame).
 */
export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resolve outcome for a simulator frame (D-07). Gates the UI's
 * "Promote to fallback" button: visible only for `"fuzzy"`.
 */
export type MatchKind = "primary" | "fuzzy" | "none";

/**
 * Mirror of `automation::StepFrame` — per-step capture emitted when the
 * simulator runs with `capture_frames=true`.
 */
export interface StepFrame {
  ordinal: number;
  screenshot_path: string | null;
  cursor_xy: [number, number];
  matched_selector: string | null;
  matched_bbox: BoundingBox | null;
  match_kind: MatchKind;
  duration_ms: number;
}

/**
 * Mirror of `automation::ExecutorEvent` (Rust uses `#[serde(tag="type",
 * rename_all="snake_case")]`, so JSON looks like `{ type: "step_started", ... }`).
 */
export type ExecutorEvent =
  | { type: "story_started"; story_hash: string }
  | { type: "scene_entered"; name: string; ordinal: number }
  | { type: "step_started"; ordinal: number; command: unknown; driver_used: string }
  | { type: "step_attempt"; step_ordinal: number; attempt: unknown }
  | { type: "step_succeeded"; ordinal: number; duration_ms: number; cursor_x: number; cursor_y: number }
  | { type: "step_failed"; ordinal: number; attempts: unknown[]; error_message: string; screenshot_path?: string }
  | { type: "story_ended"; status: { total_steps: number; succeeded: number; failed: number; duration_ms: number } }
  | { type: "run_paused"; ordinal: number }
  | { type: "step_frame_captured"; ordinal: number; frame: StepFrame };

export interface LaunchAutomationArgs {
  storySource: string;
  projectFolder: string;
  /**
   * Plan 06-02 — when true, the host validates meta.app via `url::Url`
   * and appends `--app=<meta.app>` to Playwright's launch args (D-09/
   * D-10). Non-sticky: the recorder resets the backing toggle each run.
   */
  chromeHiding?: boolean;
  /**
   * Attach an active recording session to the DSL run. When set, the host
   * auto-stops the matching recording at story end (normal, error, or
   * channel close), so the encoder sidecar finalizes cleanly without the
   * UI having to call `stopRecording` itself.
   */
  recordingSessionId?: string;
}

/**
 * Shape returned to the caller when they need a handle to the live
 * automation Channel — e.g., to null `onmessage` during React unmount
 * cleanup (D-14) so no stale event dispatch runs against an unmounted
 * component tree.
 */
export interface AutomationChannelHandle {
  /** Null this to stop forwarding events to `onEvent`. */
  onmessage: ((e: { json: string }) => void) | null;
}

export async function launchAutomation(
  args: LaunchAutomationArgs,
  onEvent: (e: ExecutorEvent) => void,
  onChannelReady?: (channel: AutomationChannelHandle) => void,
): Promise<void> {
  const channel = new Channel<{ json: string }>();
  channel.onmessage = (wrapper) => {
    try {
      const parsed = JSON.parse(wrapper.json) as ExecutorEvent;
      onEvent(parsed);
    } catch {
      // ignore malformed events
    }
  };
  onChannelReady?.(channel);
  await invoke("launch_automation", {
    storySource: args.storySource,
    projectFolder: args.projectFolder,
    onEvent: channel,
    chromeHiding: args.chromeHiding ?? false,
    recordingSessionId: args.recordingSessionId ?? null,
  });
}

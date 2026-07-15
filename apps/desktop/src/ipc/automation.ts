/** Automation IPC wrappers. */

import type { RecordingOutcomeV1 } from "@storycapture/shared-types";
import { Channel, invoke } from "@tauri-apps/api/core";
import { DEFAULT_RECORDING_PACING, type RecordingPacingProfile } from "@/state/output-prefs";

/**
 * Bounding box carried on StepFrame.
 */
export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resolve outcome for a simulator frame. Gates the UI's
 * "Promote to fallback" button: visible only for `"fuzzy"`.
 */
export type MatchKind = "primary" | "fuzzy" | "none";

export type RecordingRepairAction =
  | "retry_step"
  | "use_candidate_and_retry"
  | "await_presentation"
  | "retry_scene"
  | "abort_keep_salvage";

export interface RepairRequiredEvent {
  type: "repair-required";
  session_id: string;
  repair_token: string;
  scene_id: string;
  step_id: string;
  ordinal: number;
  phase: "pre_input" | "input_emitted_presentation_pending" | "post_input_failed";
  reason_code: string;
  candidates: Array<{ key: string; source: string; fallback_index: number | null }>;
  attempt: number;
  allowed_actions: RecordingRepairAction[];
  expires_at_ms: number;
}

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
  | {
      type: "step_succeeded";
      ordinal: number;
      step_id: string | null;
      duration_ms: number;
      cursor_x: number;
      cursor_y: number;
      matched_selector: string | null;
      matched_bbox: BoundingBox | null;
      match_kind: MatchKind;
      target_source?: "sidecar_primary" | "story_target" | "sidecar_fallback" | null;
      fallback_index?: number | null;
      target_key?: string | null;
      target_attempts?: unknown[];
    }
  | { type: "action_recorded"; event: unknown }
  | {
      type: "step_failed";
      ordinal: number;
      attempts: unknown[];
      error_message: string;
      screenshot_path?: string;
    }
  | {
      type: "story_ended";
      status: { total_steps: number; succeeded: number; failed: number; duration_ms: number };
    }
  | { type: "recording_outcome_shadow"; outcome: RecordingOutcomeV1 }
  | RepairRequiredEvent
  | { type: "run_paused"; ordinal: number }
  | { type: "step_frame_captured"; ordinal: number; frame: StepFrame };

export function resolveRecordingRepair(input: {
  sessionId: string;
  repairToken: string;
  action: RecordingRepairAction;
  candidateKey?: string;
}): Promise<{ version: 1; accepted: true }> {
  return invoke("resolve_recording_repair", {
    session: { id: input.sessionId },
    repair_token: input.repairToken,
    action: input.action,
    candidate_key: input.candidateKey,
  });
}

export interface LaunchAutomationArgs {
  storySource: string;
  storyPath?: string;
  projectFolder: string;
  /** Existing author-preview stream to execute against instead of spawning a throwaway browser. */
  streamId?: string | null;
  /**
   * Logical desktop origin for the selected recording display. macOS uses it
   * to place Chromium on the intended monitor before DPR detection.
   */
  recordingDisplay?: { x: number; y: number } | null;
  /**
   * Recording-only browser viewport. Used when the story viewport is larger
   * than the selected display can fit in logical pixels.
   */
  recordingViewport?: { width: number; height: number } | null;
  /**
   * When true, the host validates meta.app via `url::Url` and appends
   * `--app=<meta.app>` to Playwright's launch args. Non-sticky: the
   * recorder resets the backing toggle each run.
   */
  chromeHiding?: boolean;
  pacingProfile?: RecordingPacingProfile;
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
 * cleanup so no stale event dispatch runs against an unmounted
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
    storyPath: args.storyPath ?? null,
    projectFolder: args.projectFolder,
    streamId: args.streamId ?? null,
    onEvent: channel,
    chromeHiding: args.chromeHiding ?? false,
    pacingProfile: args.pacingProfile ?? DEFAULT_RECORDING_PACING,
    recordingSessionId: args.recordingSessionId ?? null,
    recordingDisplay: args.recordingDisplay ?? null,
    recordingViewport: args.recordingViewport ?? null,
  });
}

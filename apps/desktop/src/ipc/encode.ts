/**
 * Encoder / recording IPC wrappers (Plan 01-08 commands). See
 * `apps/desktop/src-tauri/src/commands/encode.rs`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import type { CaptureTarget } from "./capture";

export interface StartRecordingArgs {
  project_folder: string;
  /**
   * Backlog #15 — full CaptureTarget DTO. Replaces the earlier flat
   * `display_id: number`. `kind: "display"` preserves the pre-#15
   * behaviour; other variants route through the same window/region
   * code paths used by `start_capture_target`.
   */
  target: CaptureTarget;
  width: number;
  height: number;
  fps: number;
  /**
   * Phase 6 plan 01 — optional mic device. `null` / undefined = no
   * audio (silent track, Phase 1 behavior). `"default"` = host resolves
   * the system default input device. Any other string is a cpal device
   * name from `listAudioInputs`. Non-sticky per D-02 — the recorder
   * resets this to null on mount and on recording complete.
   */
  audio_device_id?: string | null;
  /**
   * Plan 06-02 — per-recording include-cursor flag (D-19/D-20).
   * `undefined` / `null` → backend default (true). Non-sticky: the
   * recorder store resets this to true on mount and on recording-complete.
   */
  include_cursor?: boolean | null;
}

export interface RecordingSessionId {
  id: string;
}

/**
 * `RecordingEvent` is a tagged union surfaced by the host over a Tauri
 * Channel. The renderer treats it as JSON and switches on `kind`. See
 * `RecordingEvent` in `commands/encode.rs` for the authoritative shape.
 */
export type RecordingEvent =
  | { kind: "EncodeProgress"; progress: unknown }
  | { kind: "CaptureStatus"; json: string }
  | { kind: "Completed"; result: { output_path: string; duration_ms: number; [k: string]: unknown } }
  | { kind: "Failed"; message: string }
  | { kind: "StepStarted"; index: number; verb: string }
  | { kind: "StepSucceeded"; index: number; cursor_x?: number; cursor_y?: number }
  | { kind: "StepFailed"; index: number; message: string };

export async function probeHwEncoders(): Promise<unknown> {
  return invoke("probe_hw_encoders");
}

export async function startRecording(
  args: StartRecordingArgs,
  onEvent: (e: RecordingEvent) => void,
): Promise<RecordingSessionId> {
  const channel = new Channel<RecordingEvent>();
  channel.onmessage = (evt) => onEvent(evt);
  return invoke<RecordingSessionId>("start_recording", {
    args,
    onEvent: channel,
  });
}

export async function stopRecording(
  session: RecordingSessionId,
  onEvent: (e: RecordingEvent) => void,
): Promise<unknown> {
  const channel = new Channel<RecordingEvent>();
  channel.onmessage = (evt) => onEvent(evt);
  return invoke("stop_recording", { session, onEvent: channel });
}

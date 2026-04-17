/**
 * Encoder / recording IPC wrappers (Plan 01-08 commands). See
 * `apps/desktop/src-tauri/src/commands/encode.rs`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export interface StartRecordingArgs {
  project_folder: string;
  display_id: number;
  width: number;
  height: number;
  fps: number;
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

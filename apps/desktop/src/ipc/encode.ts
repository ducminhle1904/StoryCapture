/**
 * Encoder / recording IPC wrappers (Plan 01-08 commands). See
 * `apps/desktop/src-tauri/src/commands/encode.rs`.
 */

import type {
  FitModeDto,
  OutputResolutionDto,
  PadColorDto,
  QualityPresetDto,
  ScaleAlgoDto,
} from "@storycapture/shared-types";
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
   * the system default input device. Any other string is a stable cpal
   * device id from `listAudioInputs`. Non-sticky per D-02 — the recorder
   * resets this to null on mount and on recording complete.
   */
  audio_device_id?: string | null;
  /**
   * Plan 06-02 — per-recording include-cursor flag (D-19/D-20).
   * `undefined` / `null` → backend default (true). Non-sticky: the
   * recorder store resets this to true on mount and on recording-complete.
   */
  include_cursor?: boolean | null;
  /** Phase 13 D-13-08 — output resolution. undefined → backend default (1080p). */
  output_resolution?: OutputResolutionDto | null;
  /** Phase 13 D-13-12 — fit mode. undefined → backend default (letterbox). */
  fit_mode?: FitModeDto | null;
  /** Phase 13 D-13-09 — pad color. undefined → backend default (black). */
  pad_color?: PadColorDto | null;
  /** Phase 13 D-13-11 — quality preset. undefined → backend default (med). */
  quality_preset?: QualityPresetDto | null;
  /** Phase 13 D-13-08 — scale algorithm. undefined → backend default (lanczos). */
  scale_algo?: ScaleAlgoDto | null;
}

export interface RecordingSessionId {
  id: string;
}

export interface EncodeResultDto {
  output_path: string;
  duration_ms: number;
  bytes?: number;
  frames_written?: number;
  frames_dropped?: number;
  [k: string]: unknown;
}

/**
 * `RecordingEvent` is a tagged union surfaced by the host over a Tauri
 * Channel. The renderer switches on the Rust `#[serde(tag = "type")]`
 * discriminator. See
 * `RecordingEvent` in `commands/encode.rs` for the authoritative shape.
 */
export type RecordingEvent =
  | { type: "encode-progress"; progress: unknown }
  | { type: "capture-status"; json: string }
  | { type: "frames-dropped"; total: number; delta: number }
  | { type: "completed"; result: EncodeResultDto }
  | { type: "failed"; message: string }
  // D-13: mic negotiation/start failure — recording continues video-only.
  | { type: "audio-unavailable"; reason: string }
  // D-15: 2s liveness tick from the host; renderer watchdog detects gaps.
  | { type: "heartbeat"; seq: number | bigint };

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
  onEvent: (e: RecordingEvent) => void = () => {},
): Promise<EncodeResultDto> {
  const channel = new Channel<RecordingEvent>();
  channel.onmessage = (evt) => onEvent(evt);
  return invoke<EncodeResultDto>("stop_recording", { session, onEvent: channel });
}

export async function pauseRecording(session: RecordingSessionId): Promise<void> {
  return invoke("pause_recording", { session });
}

export async function resumeRecording(session: RecordingSessionId): Promise<void> {
  return invoke("resume_recording", { session });
}

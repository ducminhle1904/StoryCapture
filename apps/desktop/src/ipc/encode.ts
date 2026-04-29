/**
 * Encoder / recording IPC wrappers. See
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
   * Full CaptureTarget DTO. `kind: "display"` mirrors the legacy flat
   * display_id behaviour; other variants route through the same
   * window/region code paths used by `start_capture_target`.
   */
  target: CaptureTarget;
  width: number;
  height: number;
  fps: number;
  /**
   * Optional mic device. `null` / undefined = no audio (silent track).
   * `"default"` = host resolves the system default input device. Any
   * other string is a stable cpal device id from `listAudioInputs`.
   * Non-sticky — the recorder resets this to null on mount and on
   * recording complete.
   */
  audio_device_id?: string | null;
  /**
   * Per-recording include-cursor flag. `undefined` / `null` → backend
   * default (true). Non-sticky: the recorder store resets this to true
   * on mount and on recording-complete.
   */
  include_cursor?: boolean | null;
  /** Output resolution. undefined → backend default (1080p). */
  output_resolution?: OutputResolutionDto | null;
  /** Fit mode. undefined → backend default (letterbox). */
  fit_mode?: FitModeDto | null;
  /** Pad color. undefined → backend default (black). */
  pad_color?: PadColorDto | null;
  /** Quality preset. undefined → backend default (med). */
  quality_preset?: QualityPresetDto | null;
  /** Scale algorithm. undefined → backend default (lanczos). */
  scale_algo?: ScaleAlgoDto | null;
  /** Optional crop applied before encoding. */
  frame_crop?: {
    x: number;
    y: number;
    w: number;
    h: number;
    basis_w?: number | null;
    basis_h?: number | null;
  } | null;
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
  // Mic negotiation/start failure — recording continues video-only.
  | { type: "audio-unavailable"; reason: string }
  // 2s liveness tick from the host; renderer watchdog detects gaps.
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

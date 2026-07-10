/** Encoder / recording IPC wrappers. */

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
  /** Output resolution. undefined → backend default (match source). */
  output_resolution?: OutputResolutionDto | null;
  /** Fit mode. undefined → backend default (letterbox). */
  fit_mode?: FitModeDto | null;
  /** Pad color. undefined → backend default (black). */
  pad_color?: PadColorDto | null;
  /** Quality preset. undefined → backend default (high). */
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
    scale_hint?: number | null;
  } | null;
}

export interface RecordingSessionId {
  id: string;
}

export interface RecordingLifecycleAck {
  status: "recording" | "paused";
}

export interface EncodeResultDto {
  output_path: string;
  duration_ms: number;
  frame_count?: number;
  duration_us?: number;
  media_clock?: {
    clock: "encoded_video_pts";
    unit: "us";
    fps_num: number;
    fps_den: number;
    origin_frame: 0;
    frame_count: number;
    duration_us: number;
  };
  bytes?: number;
  frames_written?: number;
  frames_encoded?: number;
  frames_dropped?: number;
  requested_fps?: number;
  effective_fps?: number;
  actual_capture_fps?: number;
  encoded_fps?: number;
  source_capture_fps?: number;
  source_frames_received?: number;
  skipped_ticks?: number;
  encoder_backpressure_events?: number;
  late_frames?: number;
  capture_duration_ms_p50?: number | null;
  capture_duration_ms_p95?: number | null;
  cadence_warning?: string | null;
  cadence_warning_message?: string | null;
  output_width?: number;
  output_height?: number;
  fit_mode?: FitModeDto;
  quality_preset?: QualityPresetDto;
  encoder_input?: "author_preview_raw_bgra_pipe" | "png_sequence";
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
  return invoke<EncodeResultDto>("stop_recording", {
    session,
    onEvent: channel,
  });
}

export async function pauseRecording(session: RecordingSessionId): Promise<RecordingLifecycleAck> {
  return invoke("pause_recording", { session });
}

export async function resumeRecording(session: RecordingSessionId): Promise<RecordingLifecycleAck> {
  return invoke("resume_recording", { session });
}

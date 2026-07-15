/** Encoder / recording IPC wrappers. */

import type {
  FitModeDto,
  OutputResolutionDto,
  PadColorDto,
  QualityPresetDto,
  RecordingOutcomeV1,
  RecordingTerminalEventV1,
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

export interface RecordingPreflightRequestV1 {
  version: 1;
  target: CaptureTarget;
  output_directory: string;
  width: number;
  height: number;
  fps: number;
  audio_roles: Array<{
    role: "microphone" | "tab" | "system";
    policy: "required" | "optional";
    device_id?: string | null;
  }>;
  available_audio_input_ids?: string[];
}

export interface RecordingPreflightCheckV1 {
  id:
    | "permission"
    | "target_live"
    | "encoder_available"
    | "output_valid"
    | "disk_space"
    | "audio_device"
    | "no_active_session";
  status: "pass" | "warn" | "block";
  reason: string;
  detail: string;
  remediation?: string;
}

export interface RecordingPreflightReportV1 {
  version: 1;
  mode: "warn" | "block";
  checked_at: string;
  fingerprint: string;
  verdict: "pass" | "warn" | "block";
  checks: RecordingPreflightCheckV1[];
  capabilities: {
    target: { kind: CaptureTarget["kind"]; electron_capture: string; reason: string };
    capture_profile: { width: number; height: number; fps: number; state: string; reason: string };
    encoder: { state: string; reason: string };
    audio: Array<{ role: string; required: boolean; state: string; reason: string }>;
  };
}

export interface RecordingSessionId {
  id: string;
}

export interface RecordingLifecycleAck {
  status: "recording" | "paused";
}

export type RecordingLifecycleState =
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "finalized"
  | "cancelling"
  | "cancelled"
  | "failed";

export interface RecordingLifecycleSnapshot {
  version: 1;
  session_id: string;
  state: RecordingLifecycleState;
  sequence: number;
  updated_at: string;
}

export interface CancelRecordingResultV1 {
  version: 1;
  session_id: string;
  snapshot: RecordingLifecycleSnapshot;
  outcome: RecordingOutcomeV1;
  terminal: RecordingTerminalEventV1;
  outcome_mode: "legacy" | "shadow" | "strict";
  cached: boolean;
}

export interface RecordingStatusResultV1 {
  version: 1;
  session_id: string;
  snapshot: RecordingLifecycleSnapshot;
  terminal_outcome: RecordingOutcomeV1 | null;
  terminal_event: RecordingTerminalEventV1 | null;
  outcome_mode: "legacy" | "shadow" | "strict";
  cached_until: string | null;
}

export interface InterruptedRecordingSummaryV1 {
  journal_id: string;
  take_id: string;
  interrupted_at: string;
  checkpoint: string;
  recoverability: "media" | "segments" | "diagnostic_only";
}

export interface ListInterruptedRecordingsResultV1 {
  version: 1;
  recordings: InterruptedRecordingSummaryV1[];
}

export interface RecoverInterruptedRecordingResultV1 {
  version: 1;
  journal_id: string;
  verdict: "repairable" | "failed";
  bundle_path: string;
  output_path: string | null;
  cached: boolean;
}

export interface DiscardInterruptedRecordingResultV1 {
  version: 1;
  journal_id: string;
  discarded: true;
  deleted_artifact_count: number;
  cached: boolean;
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
  health?: RecordingHealthV1 | null;
  capture_backend?: CaptureBackendProvenanceDto | null;
  [k: string]: unknown;
}

export interface CaptureBackendProvenanceDto {
  contract_version: 1;
  mode: "legacy" | "contract_shadow" | "contract_internal" | "contract_ga";
  selected_backend_id: string;
  attempted_backend_id: string | null;
  fallback_reason: string | null;
  delivery_mode: "host_frames" | "backend_segment";
  timestamp_source: "recording_media_clock" | "native_monotonic";
  resolved_target_identity: string;
  platform_version: string | null;
  target_loss_reason: string | null;
  terminal_status: "pending" | "stopped" | "aborted" | "target_lost" | "failed";
}

export type RecordingHealthVerdict = "pass" | "degraded" | "fail";
export type RecordingHealthProfile = "1080p30" | "1440p30" | "unsupported";
export interface RecordingHealthV1 {
  version: 1;
  session_id: string;
  capture_path: "raw_bgra" | "png";
  profile: RecordingHealthProfile;
  verdict: RecordingHealthVerdict;
  reasons: readonly string[];
  requested_fps: number;
  observed_fps: number | null;
  expected_frames: number;
  requested_frames: number;
  source_frames: number;
  submitted_frames: number;
  encoded_frames: number;
  dropped_frames: number;
  skipped_frames: number;
  loss_ratio: number;
  first_encoded_frame_ms: number | null;
  frame_gap_p95_ms: number | null;
  frame_gap_max_ms: number | null;
  backpressure_events: number;
  backpressure_total_ms: number;
  backpressure_high_water: number;
  action_to_presentation_p95_ms: number | null;
  output_readable: boolean | null;
  finalized: boolean;
}

export interface RecordingHealthUpdateV1 {
  event: "health-update";
  phase: "snapshot" | "final";
  health: RecordingHealthV1;
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
  | { type: "heartbeat"; seq: number | bigint }
  | { type: "recording_outcome_shadow"; outcome: RecordingOutcomeV1 }
  | {
      type: "health-update";
      update?: RecordingHealthUpdateV1;
      snapshot?: EngineHealthSnapshotDto;
    }
  | { type: "terminal"; terminal: RecordingTerminalEventV1 };

export interface EngineHealthSnapshotDto {
  schema_version: 1;
  session_id: string;
  sequence: number;
  observed_at_ms: number;
  state: "starting" | "healthy" | "constrained" | "degraded" | "stalled" | "stopping";
  reason_codes: string[];
  requested_fps: number;
  effective_fps: number;
  actual_capture_fps: number;
  source_capture_fps: number;
  committed_frames: number;
  source_frames_received: number;
  frames_dropped: number;
  skipped_ticks: number;
  late_frames: number;
  encoder_backpressured: boolean;
  encoder_backpressure_events: number;
  capture_duration_ms_p95: number | null;
  last_committed_pts_us: number | null;
  encoder_alive: boolean;
  audio_tracks: Array<{
    track_id: string;
    role: "microphone" | "tab" | "system";
    requirement: "required" | "optional";
    state: "not_requested" | "starting" | "healthy" | "silent" | "failed" | "stopped";
    samples_received: number;
    last_sample_pts_us: number | null;
    terminal_reason: string | null;
  }>;
  target_liveness: {
    state: "unknown" | "live" | "stale" | "lost";
    last_observed_at_ms: number | null;
    reason: string | null;
  };
  disk: {
    free_bytes: number;
    threshold_bytes: number;
    state: "ok" | "low" | "critical";
  };
  terminal_health: {
    state: "none" | "healthy" | "repairable" | "fatal";
    reason_codes: string[];
  };
  allowed_actions: Array<"stop" | "cancel" | "repair">;
}

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

export function recordingPreflight(
  request: RecordingPreflightRequestV1,
): Promise<RecordingPreflightReportV1> {
  return invoke<RecordingPreflightReportV1>("recording_preflight", { request });
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

export async function cancelRecording(
  session: RecordingSessionId,
  requestId = globalThis.crypto.randomUUID(),
): Promise<CancelRecordingResultV1> {
  return invoke("cancel_recording", {
    version: 1,
    session,
    request_id: requestId,
  });
}

export async function getRecordingStatus(
  session: RecordingSessionId,
): Promise<RecordingStatusResultV1> {
  return invoke("get_recording_status", { version: 1, session });
}

export function openRetainedRecordingArtifact(path: string): Promise<void> {
  return invoke("plugin:shell|open", { path });
}

export async function listInterruptedRecordings(): Promise<ListInterruptedRecordingsResultV1> {
  return invoke("list_interrupted_recordings", { version: 1 });
}

export async function recoverInterruptedRecording(
  journalId: string,
  requestId = globalThis.crypto.randomUUID(),
): Promise<RecoverInterruptedRecordingResultV1> {
  return invoke("recover_interrupted_recording", {
    version: 1,
    journal_id: journalId,
    request_id: requestId,
  });
}

export async function discardInterruptedRecording(
  journalId: string,
  requestId = globalThis.crypto.randomUUID(),
): Promise<DiscardInterruptedRecordingResultV1> {
  return invoke("discard_interrupted_recording", {
    version: 1,
    journal_id: journalId,
    request_id: requestId,
  });
}

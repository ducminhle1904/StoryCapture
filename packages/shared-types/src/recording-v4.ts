export const RECORDING_V4_CONTRACT_VERSION = 4 as const;
export const RECORDING_V4_BUNDLE_SCHEMA_VERSION = 4 as const;
export const RECORDING_V4_PROFILE = "verified_1080p60" as const;
export const RECORDING_V4_FRAME_RATE = { numerator: 60, denominator: 1 } as const;
export const RECORDING_V4_FRAME_DURATION_US = 1_000_000 / 60;

export type RecordingV4Profile = typeof RECORDING_V4_PROFILE;
export type RecordingV4Platform = "darwin" | "win32";
export type RecordingV4AudioRole = "microphone" | "system";
export type RecordingV4TerminalStatus = "completed" | "quality_failed" | "cancelled" | "failed";
export type RecordingV4State =
  | "idle"
  | "preflighting"
  | "warming_up"
  | "ready"
  | "capturing"
  | "paused"
  | "stopping"
  | "verifying"
  | RecordingV4TerminalStatus;
export type RecordingV4Command = "start" | "pause" | "resume" | "stop" | "cancel";

export type RecordingV4FailureCode =
  | "contract_mismatch"
  | "illegal_transition"
  | "helper_unavailable"
  | "helper_protocol_mismatch"
  | "helper_crashed"
  | "permission_denied"
  | "target_missing"
  | "target_ambiguous"
  | "target_changed"
  | "target_lost"
  | "surface_not_1080p"
  | "storage_probe_failed"
  | "storage_insufficient"
  | "write_throughput_insufficient"
  | "hardware_encoder_unavailable"
  | "encoder_warmup_failed"
  | "encoder_rejected_frame"
  | "encoder_backpressure"
  | "frame_slot_missing"
  | "frame_ledger_invalid"
  | "output_frame_count_mismatch"
  | "output_pts_invalid"
  | "artifact_finalize_failed"
  | "artifact_probe_failed"
  | "artifact_decode_failed"
  | "quality_checkpoint_failed"
  | "bitrate_outside_envelope"
  | "audio_device_unavailable"
  | "audio_format_invalid"
  | "audio_continuity_failed"
  | "audio_sync_failed"
  | "journal_invalid"
  | "journal_recovery_failed"
  | "verification_timeout"
  | "publication_failed";

export interface RecordingV4Rational {
  numerator: number;
  denominator: number;
}

export interface RecordingV4Dimensions {
  physical_width: 1920;
  physical_height: 1080;
}

export interface RecordingV4TargetIdentity {
  kind: "window" | "author_preview";
  stable_id: string;
  process_id: number;
  initial_title: string | null;
}

export interface RecordingV4EncoderEnvelope {
  source: "live_calibration" | "certified_evidence";
  encoder_id: string;
  minimum_bitrate_bps: number;
  target_bitrate_bps: number;
  maximum_bitrate_bps: number;
  safety_headroom_ratio: number;
}

export interface RecordingV4EncoderEvidence {
  encoder_id: string;
  hardware_accelerated: true;
  requested_bitrate_bps: number;
  average_bitrate_bps: number;
  peak_bitrate_bps: number;
  envelope: RecordingV4EncoderEnvelope;
}

export interface RecordingV4FrameLedgerEntry {
  slot: number;
  pts_us: number;
  source_sequence: number;
  source_timestamp_us: number;
  held_from_slot: number | null;
  submitted_at_us: number;
  acknowledged_at_us: number;
}

export interface RecordingV4CadenceEvidence {
  version: typeof RECORDING_V4_CONTRACT_VERSION;
  frame_rate: typeof RECORDING_V4_FRAME_RATE;
  active_duration_us: number;
  expected_output_frames: number;
  output_frames: number;
  source_updates: number;
  held_frames: number;
  submitted_frames: number;
  acknowledged_frames: number;
  ring_high_water_mark: number;
  pause_intervals: Array<{ started_monotonic_us: number; ended_monotonic_us: number }>;
  ledger: RecordingV4FrameLedgerEntry[];
  verdict: "passed" | "failed";
  failure_codes: RecordingV4FailureCode[];
}

export interface RecordingV4AudioLedgerEntry {
  sequence: number;
  pts_us: number;
  duration_us: number;
  frames: number;
}

export interface RecordingV4AudioEvidence {
  role: RecordingV4AudioRole;
  requested: true;
  status: "captured" | "failed";
  codec: "pcm_f32le" | "pcm_s16le" | "aac";
  sample_rate_hz: number;
  channels: number;
  started_offset_us: number;
  duration_us: number;
  end_drift_us: number;
  sync_tolerance_us: number;
  pause_mapping_valid: boolean;
  continuity_gaps: number;
  ledger: RecordingV4AudioLedgerEntry[];
  failure_codes: RecordingV4FailureCode[];
}

export interface RecordingV4QualityMetric {
  measured: number;
  threshold: number;
  comparator: "gte" | "lte";
  passed: boolean;
}

export interface RecordingV4QualityCheckpoint {
  frame_slot: number;
  reference_id: string;
  full_frame_luma_ssim: RecordingV4QualityMetric;
  text_edge_roi_ssim: RecordingV4QualityMetric;
  edge_spread_increase_px: RecordingV4QualityMetric;
  color_channel_delta: RecordingV4QualityMetric;
}

export interface RecordingV4QualityEvidence {
  checkpoints: RecordingV4QualityCheckpoint[];
  verdict: "passed" | "failed";
  failure_codes: RecordingV4FailureCode[];
}

export interface RecordingV4Artifact {
  relative_path: string;
  bytes: number;
  sha256: string;
}

export interface RecordingV4Preflight {
  version: typeof RECORDING_V4_CONTRACT_VERSION;
  profile: RecordingV4Profile;
  platform: RecordingV4Platform;
  target: RecordingV4TargetIdentity;
  dimensions: RecordingV4Dimensions;
  permission_granted: boolean;
  storage_available_bytes: number;
  storage_required_bytes: number;
  measured_write_bytes_per_second: number;
  encoder: RecordingV4EncoderEvidence | null;
  requested_audio_roles: RecordingV4AudioRole[];
  available_audio_roles: RecordingV4AudioRole[];
  passed: boolean;
  failure_codes: RecordingV4FailureCode[];
}

export interface RecordingV4Bundle {
  schema_version: typeof RECORDING_V4_BUNDLE_SCHEMA_VERSION;
  profile: RecordingV4Profile;
  status: Extract<RecordingV4TerminalStatus, "completed" | "quality_failed">;
  session_id: string;
  created_at: string;
  target: RecordingV4TargetIdentity;
  dimensions: RecordingV4Dimensions;
  master: RecordingV4Artifact & {
    relative_path: "master/video.mp4";
    codec: "h264";
    pixel_format: "yuv420p";
    frame_rate: typeof RECORDING_V4_FRAME_RATE;
    frame_count: number;
    encoder: RecordingV4EncoderEvidence;
  };
  audio: Array<RecordingV4Artifact & { role: RecordingV4AudioRole; evidence: RecordingV4AudioEvidence }>;
  cadence: RecordingV4CadenceEvidence;
  quality: RecordingV4QualityEvidence;
  artifact: {
    finalized: boolean;
    full_decode_succeeded: boolean;
    decoded_frames: number;
    duration_us: number;
  };
  evidence: {
    cadence_path: "evidence/cadence.json";
    quality_path: "evidence/quality.json";
    bitrate_path: "evidence/bitrate.json";
    frame_ledger_path: "evidence/frame-ledger.jsonl";
    audio_ledger_path: "evidence/audio-ledger.jsonl" | null;
  };
  sidecars: { actions_path: "sidecars/actions.json" | null };
  failure_codes: RecordingV4FailureCode[];
}

export interface RecordingV4ResultBase {
  version: typeof RECORDING_V4_CONTRACT_VERSION;
  profile: RecordingV4Profile;
  session_id: string;
  state: RecordingV4TerminalStatus;
  bundle_path: string | null;
  output_path: string | null;
  diagnostic_bundle_path: string | null;
  failure_codes: RecordingV4FailureCode[];
}

export type RecordingV4Result =
  | (RecordingV4ResultBase & {
      state: "completed";
      bundle_path: string;
      output_path: string;
      diagnostic_bundle_path: null;
      failure_codes: [];
    })
  | (RecordingV4ResultBase & {
      state: "quality_failed";
      bundle_path: string;
      output_path: null;
      diagnostic_bundle_path: string;
    })
  | (RecordingV4ResultBase & {
      state: "cancelled" | "failed";
      bundle_path: null;
      output_path: null;
    });

export interface RecordingV4Snapshot {
  version: typeof RECORDING_V4_CONTRACT_VERSION;
  session_id: string;
  state: RecordingV4State;
  revision: number;
  active_media_time_us: number;
  requested_audio_roles: RecordingV4AudioRole[];
  cadence: RecordingV4CadenceEvidence | null;
  terminal_result: RecordingV4Result | null;
}

export type RecordingV4Event =
  | { type: "snapshot"; snapshot: RecordingV4Snapshot }
  | { type: "preflight"; result: RecordingV4Preflight }
  | { type: "state-changed"; from: RecordingV4State; to: RecordingV4State; revision: number }
  | { type: "live-evidence"; cadence: RecordingV4CadenceEvidence }
  | { type: "terminal"; result: RecordingV4Result }
  | { type: "heartbeat"; revision: number; monotonic_us: number };

export interface RecordingV4Journal {
  version: typeof RECORDING_V4_CONTRACT_VERSION;
  session_id: string;
  project_path: string;
  workspace_path: string;
  state: RecordingV4State;
  revision: number;
  helper_pid: number | null;
  created_at: string;
  updated_at: string;
  terminal_result: RecordingV4Result | null;
}

const TERMINAL_STATES = new Set<RecordingV4State>(["completed", "quality_failed", "cancelled", "failed"]);
const FAILURE_CODES = new Set<RecordingV4FailureCode>([
  "contract_mismatch", "illegal_transition", "helper_unavailable", "helper_protocol_mismatch",
  "helper_crashed", "permission_denied", "target_missing", "target_ambiguous", "target_changed",
  "target_lost", "surface_not_1080p", "storage_probe_failed", "storage_insufficient",
  "write_throughput_insufficient", "hardware_encoder_unavailable", "encoder_warmup_failed",
  "encoder_rejected_frame", "encoder_backpressure", "frame_slot_missing", "frame_ledger_invalid",
  "output_frame_count_mismatch", "output_pts_invalid", "artifact_finalize_failed", "artifact_probe_failed",
  "artifact_decode_failed", "quality_checkpoint_failed", "bitrate_outside_envelope",
  "audio_device_unavailable", "audio_format_invalid", "audio_continuity_failed", "audio_sync_failed",
  "journal_invalid", "journal_recovery_failed", "verification_timeout", "publication_failed",
]);

const NEXT_STATES: Readonly<Record<RecordingV4State, readonly RecordingV4State[]>> = {
  idle: ["preflighting", "cancelled"],
  preflighting: ["warming_up", "failed", "cancelled"],
  warming_up: ["ready", "failed", "cancelled"],
  ready: ["capturing", "failed", "cancelled"],
  capturing: ["paused", "stopping", "failed", "cancelled"],
  paused: ["capturing", "stopping", "failed", "cancelled"],
  stopping: ["verifying", "failed"],
  verifying: ["completed", "quality_failed", "failed"],
  completed: [], quality_failed: [], cancelled: [], failed: [],
};

export function isRecordingV4TerminalState(state: RecordingV4State): state is RecordingV4TerminalStatus {
  return TERMINAL_STATES.has(state);
}

export function canTransitionRecordingV4(from: RecordingV4State, to: RecordingV4State): boolean {
  return from === to ? isRecordingV4TerminalState(from) : NEXT_STATES[from].includes(to);
}

export function applyRecordingV4Command(state: RecordingV4State, command: RecordingV4Command): RecordingV4State | null {
  if (isRecordingV4TerminalState(state)) return command === "stop" || command === "cancel" ? state : null;
  if (command === "start" && state === "idle") return "preflighting";
  if (command === "pause" && state === "capturing") return "paused";
  if (command === "resume" && state === "paused") return "capturing";
  if (command === "stop" && (state === "capturing" || state === "paused")) return "stopping";
  if (command === "cancel") return "cancelled";
  return null;
}

export function recordingV4ExpectedFrameCount(activeDurationUs: number): number {
  if (!Number.isSafeInteger(activeDurationUs) || activeDurationUs < 0) throw new RangeError("activeDurationUs");
  return Math.round((activeDurationUs * 60) / 1_000_000);
}

export function recordingV4PtsUs(slot: number): number {
  if (!Number.isSafeInteger(slot) || slot < 0) throw new RangeError("slot");
  return Math.round((slot * 1_000_000) / 60);
}

export function recordingV4AudioSyncPassed(
  startedOffsetUs: number,
  endDriftUs: number,
  toleranceUs: number,
): boolean {
  return Number.isSafeInteger(startedOffsetUs) && Number.isSafeInteger(endDriftUs) &&
    Number.isSafeInteger(toleranceUs) && toleranceUs >= 0 &&
    Math.abs(startedOffsetUs) <= toleranceUs && Math.abs(endDriftUs) <= toleranceUs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isFailureCodes(value: unknown): value is RecordingV4FailureCode[] {
  return Array.isArray(value) && value.every((code) => FAILURE_CODES.has(code));
}
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function isMetric(value: unknown): value is RecordingV4QualityMetric {
  if (!isRecord(value) || typeof value.measured !== "number" || !Number.isFinite(value.measured) ||
    typeof value.threshold !== "number" || !Number.isFinite(value.threshold) ||
    (value.comparator !== "gte" && value.comparator !== "lte") || typeof value.passed !== "boolean") return false;
  const passed = value.comparator === "gte" ? value.measured >= value.threshold : value.measured <= value.threshold;
  return value.passed === passed;
}
function isEncoderEvidence(value: unknown): value is RecordingV4EncoderEvidence {
  if (!isRecord(value) || typeof value.encoder_id !== "string" || value.hardware_accelerated !== true ||
    !isPositiveInteger(value.requested_bitrate_bps) || !isPositiveInteger(value.average_bitrate_bps) ||
    !isPositiveInteger(value.peak_bitrate_bps) || !isRecord(value.envelope)) return false;
  const envelope = value.envelope;
  return (envelope.source === "live_calibration" || envelope.source === "certified_evidence") &&
    envelope.encoder_id === value.encoder_id && isPositiveInteger(envelope.minimum_bitrate_bps) &&
    isPositiveInteger(envelope.target_bitrate_bps) && isPositiveInteger(envelope.maximum_bitrate_bps) &&
    envelope.minimum_bitrate_bps <= envelope.target_bitrate_bps &&
    envelope.target_bitrate_bps <= envelope.maximum_bitrate_bps &&
    typeof envelope.safety_headroom_ratio === "number" && envelope.safety_headroom_ratio > 0 &&
    envelope.safety_headroom_ratio < 1 && value.requested_bitrate_bps === envelope.target_bitrate_bps &&
    value.average_bitrate_bps >= envelope.minimum_bitrate_bps &&
    value.average_bitrate_bps <= envelope.maximum_bitrate_bps &&
    value.peak_bitrate_bps >= value.average_bitrate_bps &&
    value.peak_bitrate_bps <= envelope.maximum_bitrate_bps;
}
function isFrameLedger(value: unknown, expected: number): value is RecordingV4FrameLedgerEntry[] {
  if (!Array.isArray(value) || value.length !== expected) return false;
  return value.every((entry, slot) => {
    if (!isRecord(entry) || entry.slot !== slot || entry.pts_us !== recordingV4PtsUs(slot) ||
      !isNonNegativeInteger(entry.source_sequence) || !isNonNegativeInteger(entry.source_timestamp_us) ||
      !isNonNegativeInteger(entry.submitted_at_us) || !isNonNegativeInteger(entry.acknowledged_at_us) ||
      entry.acknowledged_at_us < entry.submitted_at_us) return false;
    if (entry.held_from_slot === null) return slot === 0 || entry.source_sequence !== value[slot - 1]?.source_sequence;
    return isNonNegativeInteger(entry.held_from_slot) && entry.held_from_slot < slot &&
      value[entry.held_from_slot]?.source_sequence === entry.source_sequence;
  });
}
function isCadence(value: unknown): value is RecordingV4CadenceEvidence {
  if (!isRecord(value) || value.version !== 4 || !isRecord(value.frame_rate) ||
    value.frame_rate.numerator !== 60 || value.frame_rate.denominator !== 1 ||
    !isNonNegativeInteger(value.active_duration_us) || !isNonNegativeInteger(value.expected_output_frames) ||
    value.expected_output_frames !== recordingV4ExpectedFrameCount(value.active_duration_us) ||
    value.output_frames !== value.expected_output_frames || value.submitted_frames !== value.output_frames ||
    value.acknowledged_frames !== value.output_frames || !isNonNegativeInteger(value.source_updates) ||
    !isNonNegativeInteger(value.held_frames) || value.held_frames > value.output_frames ||
    !isNonNegativeInteger(value.ring_high_water_mark) || !Array.isArray(value.pause_intervals) ||
    !isFailureCodes(value.failure_codes) || (value.verdict !== "passed" && value.verdict !== "failed")) return false;
  const pausesValid = value.pause_intervals.every((pause) => isRecord(pause) &&
    isNonNegativeInteger(pause.started_monotonic_us) && isNonNegativeInteger(pause.ended_monotonic_us) &&
    pause.ended_monotonic_us >= pause.started_monotonic_us);
  const heldCount = Array.isArray(value.ledger)
    ? value.ledger.filter((entry) => isRecord(entry) && entry.held_from_slot !== null).length
    : -1;
  return pausesValid && value.source_updates + value.held_frames === value.output_frames &&
    heldCount === value.held_frames && isFrameLedger(value.ledger, value.output_frames) &&
    (value.verdict === "passed" ? value.failure_codes.length === 0 : value.failure_codes.length > 0);
}
function isAudio(value: unknown): value is RecordingV4AudioEvidence {
  if (!isRecord(value) || (value.role !== "microphone" && value.role !== "system") || value.requested !== true ||
    (value.status !== "captured" && value.status !== "failed") ||
    !["pcm_f32le", "pcm_s16le", "aac"].includes(String(value.codec)) ||
    !isPositiveInteger(value.sample_rate_hz) || !isPositiveInteger(value.channels) ||
    !Number.isSafeInteger(value.started_offset_us) || !isNonNegativeInteger(value.duration_us) ||
    !Number.isSafeInteger(value.end_drift_us) || !isNonNegativeInteger(value.sync_tolerance_us) ||
    typeof value.pause_mapping_valid !== "boolean" ||
    !isNonNegativeInteger(value.continuity_gaps) || !Array.isArray(value.ledger) || !isFailureCodes(value.failure_codes)) return false;
  const ledgerValid = value.ledger.every((entry, index) => isRecord(entry) && entry.sequence === index &&
    isNonNegativeInteger(entry.pts_us) && isPositiveInteger(entry.duration_us) && isPositiveInteger(entry.frames));
  const capturedValid = value.continuity_gaps === 0 && value.pause_mapping_valid &&
    recordingV4AudioSyncPassed(
      value.started_offset_us as number,
      value.end_drift_us as number,
      value.sync_tolerance_us,
    );
  return ledgerValid && (value.duration_us === 0 || value.ledger.length > 0) && (value.status === "captured"
    ? value.failure_codes.length === 0 && capturedValid
    : value.failure_codes.length > 0);
}
function isQuality(value: unknown): value is RecordingV4QualityEvidence {
  if (!isRecord(value) || !Array.isArray(value.checkpoints) || value.checkpoints.length === 0 ||
    (value.verdict !== "passed" && value.verdict !== "failed") || !isFailureCodes(value.failure_codes)) return false;
  const checkpointsValid = value.checkpoints.every((checkpoint) => isRecord(checkpoint) &&
    isNonNegativeInteger(checkpoint.frame_slot) && typeof checkpoint.reference_id === "string" &&
    isMetric(checkpoint.full_frame_luma_ssim) && isMetric(checkpoint.text_edge_roi_ssim) &&
    isMetric(checkpoint.edge_spread_increase_px) && isMetric(checkpoint.color_channel_delta));
  return checkpointsValid && (value.verdict === "passed" ? value.failure_codes.length === 0 : value.failure_codes.length > 0);
}

export function readRecordingV4Bundle(value: unknown): RecordingV4Bundle | null {
  if (!isRecord(value) || value.schema_version !== 4 || value.profile !== RECORDING_V4_PROFILE ||
    (value.status !== "completed" && value.status !== "quality_failed") || typeof value.session_id !== "string" ||
    typeof value.created_at !== "string" || !isRecord(value.target) || !isRecord(value.dimensions) ||
    value.dimensions.physical_width !== 1920 || value.dimensions.physical_height !== 1080 ||
    !isRecord(value.master) || value.master.relative_path !== "master/video.mp4" || value.master.codec !== "h264" ||
    value.master.pixel_format !== "yuv420p" || !isPositiveInteger(value.master.bytes) || !isSha256(value.master.sha256) ||
    !isRecord(value.master.frame_rate) || value.master.frame_rate.numerator !== 60 || value.master.frame_rate.denominator !== 1 ||
    !isPositiveInteger(value.master.frame_count) || !isEncoderEvidence(value.master.encoder) ||
    !Array.isArray(value.audio) || !isCadence(value.cadence) || !isQuality(value.quality) ||
    !isRecord(value.artifact) || typeof value.artifact.finalized !== "boolean" ||
    typeof value.artifact.full_decode_succeeded !== "boolean" || !isNonNegativeInteger(value.artifact.decoded_frames) ||
    !isNonNegativeInteger(value.artifact.duration_us) || !isRecord(value.evidence) || !isRecord(value.sidecars) ||
    !isFailureCodes(value.failure_codes)) return null;
  const audioValid = value.audio.every((artifact) => isRecord(artifact) &&
    (artifact.role === "microphone" || artifact.role === "system") && isPositiveInteger(artifact.bytes) &&
    isSha256(artifact.sha256) && isAudio(artifact.evidence) && artifact.evidence.role === artifact.role);
  const evidenceValid = value.evidence.cadence_path === "evidence/cadence.json" &&
    value.evidence.quality_path === "evidence/quality.json" && value.evidence.bitrate_path === "evidence/bitrate.json" &&
    value.evidence.frame_ledger_path === "evidence/frame-ledger.jsonl" &&
    (value.evidence.audio_ledger_path === null || value.evidence.audio_ledger_path === "evidence/audio-ledger.jsonl");
  const completed = value.status === "completed" && value.cadence.verdict === "passed" && value.quality.verdict === "passed" &&
    value.artifact.finalized === true && value.artifact.full_decode_succeeded === true &&
    value.artifact.decoded_frames === value.master.frame_count && value.master.frame_count === value.cadence.output_frames &&
    value.failure_codes.length === 0 && value.audio.every((entry) => entry.evidence.status === "captured");
  const qualityFailed = value.status === "quality_failed" && (value.failure_codes.length > 0 ||
    value.cadence.verdict === "failed" || value.quality.verdict === "failed" ||
    value.audio.some((entry) => entry.evidence.status === "failed") || !value.artifact.full_decode_succeeded);
  return audioValid && evidenceValid && (completed || qualityFailed) ? value as unknown as RecordingV4Bundle : null;
}

export function readRecordingV4Journal(value: unknown): RecordingV4Journal | null {
  if (!isRecord(value) || value.version !== 4 || typeof value.session_id !== "string" ||
    typeof value.project_path !== "string" || typeof value.workspace_path !== "string" ||
    !Object.hasOwn(NEXT_STATES, String(value.state)) || !isNonNegativeInteger(value.revision) ||
    (value.helper_pid !== null && !isPositiveInteger(value.helper_pid)) || typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string") return null;
  const terminal = isRecordingV4TerminalState(value.state as RecordingV4State);
  if (terminal !== (value.terminal_result !== null)) return null;
  if (terminal && (!isRecord(value.terminal_result) || value.terminal_result.version !== 4 ||
    value.terminal_result.session_id !== value.session_id || value.terminal_result.state !== value.state)) return null;
  return value as unknown as RecordingV4Journal;
}

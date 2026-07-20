/**
 * JSON-safe contracts for the source-driven recording pipeline.
 *
 * These definitions intentionally use finite numbers instead of bigint so
 * manifests, evidence, persisted preferences, and IPC payloads can share the
 * same serialized shape.
 */

export const RECORDING_CONTRACT_VERSION = 2 as const;
export const RECORDING_BUNDLE_SCHEMA_VERSION = 2 as const;
export const RECORDING_COMPOSITION_SOURCE_VERSION = 2 as const;
export const STRICT_RECORDING_FRAME_RATE = { numerator: 60, denominator: 1 } as const;

export type RecordingDeliveryPolicy = "strict" | "best_effort";
export type RecordingTargetClass = "browser" | "display" | "window";
export type RecordingPlatform = "darwin" | "win32";
export type RecordingCertificationStage = "shadow" | "internal" | "certified" | "disabled";
export type RecordingQualityVerdict = "passed" | "degraded" | "failed" | "unknown";

export interface RecordingRational {
  numerator: number;
  denominator: number;
}

export interface RecordingDimensionsV2 {
  logical_width: number;
  logical_height: number;
  capture_dpr: number;
  physical_width: number;
  physical_height: number;
  requested_output_width: number;
  requested_output_height: number;
}

export interface RecordingCertifiedTier {
  version: typeof RECORDING_CONTRACT_VERSION;
  id: string;
  stage: RecordingCertificationStage;
  target_class: RecordingTargetClass;
  platform: RecordingPlatform;
  arch: string;
  backend_id: string;
  backend_version: string;
  hardware_fingerprint: string;
  exact_fps: RecordingRational;
  output_width: number;
  output_height: number;
}

export type RecordingQualityFailureCode =
  | "source_rate_mismatch"
  | "source_sequence_missing"
  | "source_sequence_gap"
  | "source_stale_reuse"
  | "scheduled_slot_skipped"
  | "submitted_frame_dropped"
  | "encoder_deadline_missed"
  | "frame_ring_overflow"
  | "preflight_failed"
  | "uncertified_tier"
  | "backend_unavailable"
  | "backend_capability_mismatch"
  | "permission_denied"
  | "target_missing"
  | "target_ambiguous"
  | "target_changed"
  | "target_lost"
  | "storage_estimate_failed"
  | "storage_reserve_exhausted"
  | "artifact_probe_failed"
  | "artifact_frame_count_mismatch"
  | "artifact_pts_gap"
  | "artifact_pts_duplicate"
  | "artifact_decode_failed"
  | "artifact_truncated"
  | "artifact_resolution_mismatch"
  | "artifact_codec_mismatch"
  | "artifact_hash_mismatch"
  | "visual_full_frame_ssim"
  | "visual_text_edge_ssim"
  | "visual_edge_contrast"
  | "visual_edge_spread"
  | "visual_overlay_geometry"
  | "visual_color_delta"
  | "verification_timeout"
  | "contract_mismatch";

export interface RecordingPreflightV2Request {
  version: typeof RECORDING_CONTRACT_VERSION;
  delivery_policy: RecordingDeliveryPolicy;
  target_class: RecordingTargetClass;
  requested_fps: RecordingRational;
  dimensions: RecordingDimensionsV2;
  audio_roles: Array<"microphone" | "system">;
  desired_tier: RecordingCertifiedTier | null;
}

export interface RecordingSourceRateProbeV2 {
  measured_fps: RecordingRational | null;
  source_presentations: number;
  sequence_gaps: number;
  stale_reuses: number;
  probe_duration_ms: number;
}

export interface RecordingStorageEstimateV2 {
  estimated_bytes_per_second: number;
  required_bytes_for_ten_minutes: number;
  available_bytes: number;
  reserve_bytes: number;
}

export interface RecordingPreflightV2Dto {
  version: typeof RECORDING_CONTRACT_VERSION;
  backend_id: string;
  backend_version: string;
  platform: RecordingPlatform;
  arch: string;
  gpu_identity: string | null;
  hardware_fingerprint: string;
  certification: RecordingCertifiedTier | null;
  certification_match: boolean;
  source_rate: RecordingSourceRateProbeV2;
  encode_throughput_ratio: number;
  storage: RecordingStorageEstimateV2;
  permissions_granted: boolean;
  strict_eligible: boolean;
  failure_codes: RecordingQualityFailureCode[];
}

export interface RecordingCadenceEvidenceV2 {
  version: typeof RECORDING_CONTRACT_VERSION;
  requested_fps: RecordingRational;
  source_fps: RecordingRational | null;
  stream_time_base: RecordingRational | null;
  active_duration_us: number;
  expected_slots: number;
  source_presentations: number;
  submitted_frames: number;
  encoder_acked_frames: number;
  artifact_decoded_frames: number;
  source_sequence_gaps: number;
  stale_reuses: number;
  skipped_slots: number;
  dropped_frames: number;
  deadline_misses: number;
  ring_overflows: number;
  backpressure_events: number;
  pts_gaps: number;
  pts_duplicates: number;
  full_decode_succeeded: boolean;
  verdict: RecordingQualityVerdict;
  failure_codes: RecordingQualityFailureCode[];
}

export interface RecordingQualityMetricV2 {
  measured: number;
  threshold: number;
  comparator: "gte" | "lte";
  passed: boolean;
}

export interface RecordingQualityEvidenceDto {
  version: typeof RECORDING_CONTRACT_VERSION;
  evaluated_frames: number;
  full_frame_luma_ssim: RecordingQualityMetricV2 | null;
  text_edge_roi_ssim: RecordingQualityMetricV2 | null;
  p01_edge_contrast_retention: RecordingQualityMetricV2 | null;
  edge_spread_increase_px: RecordingQualityMetricV2 | null;
  overlay_geometry_delta_px: RecordingQualityMetricV2 | null;
  color_channel_delta: RecordingQualityMetricV2 | null;
  lossless_master_hashes_match: boolean | null;
  verdict: RecordingQualityVerdict;
  failure_codes: RecordingQualityFailureCode[];
}

export interface RecordingCaptureContractV2 {
  exact_fps: RecordingRational;
  dimensions: RecordingDimensionsV2;
}

export interface RecordingStartV2Fields {
  contract_version?: typeof RECORDING_CONTRACT_VERSION;
  delivery_policy?: RecordingDeliveryPolicy;
  certified_tier?: RecordingCertifiedTier | null;
  capture_contract?: RecordingCaptureContractV2 | null;
}

export interface RecordingLegacyCounters {
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  frames_encoded?: number;
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  frames_dropped?: number;
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  encoded_fps?: number;
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  actual_capture_fps?: number;
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  source_frames_received?: number;
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  skipped_ticks?: number;
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  encoder_backpressure_events?: number;
  /** @deprecated Diagnostic compatibility only; never decides Strict success. */
  late_frames?: number;
}

export interface RecordingResultV2Base extends RecordingLegacyCounters {
  version: typeof RECORDING_CONTRACT_VERSION;
  delivery_policy: RecordingDeliveryPolicy;
  certified_tier: RecordingCertifiedTier | null;
  bundle_path: string;
  output_path: string | null;
  diagnostic_bundle_path: string | null;
  duration_ms: number;
  bytes: number;
  master_path: string | null;
  proxy_path: string | null;
  cadence_evidence: RecordingCadenceEvidenceV2;
  quality_evidence: RecordingQualityEvidenceDto;
}

export type RecordingResultV2 =
  | (RecordingResultV2Base & {
      status: "completed";
      output_path: string;
      diagnostic_bundle_path: null;
    })
  | (RecordingResultV2Base & {
      status: "quality_failed";
      output_path: null;
      diagnostic_bundle_path: string;
    });

export type RecordingEventV2 =
  | { type: "preflight"; result: RecordingPreflightV2Dto }
  | {
      type: "readiness";
      state: "source_ready" | "first_frame_committed" | "pre_input_frame_committed";
    }
  | { type: "live-evidence"; evidence: RecordingCadenceEvidenceV2 }
  | { type: "verifying"; progress: number }
  | { type: "completed"; result: RecordingResultV2 }
  | { type: "quality-failed"; result: RecordingResultV2 & { status: "quality_failed" } }
  | { type: "failed"; message: string }
  | { type: "audio-unavailable"; reason: string }
  | { type: "heartbeat"; seq: number };

export type AutomationRecordingOutcomeV2<TCompleted = RecordingResultV2> =
  | { status: "finalized"; result: TCompleted }
  | { status: "quality_failed"; result: RecordingResultV2 & { status: "quality_failed" } }
  | { status: "ready_to_finalize"; result: null }
  | { status: "already_finalized"; result: null }
  | { status: "not_requested"; result: null };

export interface RecordingInfoV2 {
  version: typeof RECORDING_CONTRACT_VERSION;
  path: string;
  captured_at: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  master_path: string | null;
  proxy_path: string | null;
  cadence_evidence_path: string | null;
  quality_evidence_path: string | null;
  actions_path: string | null;
  microphone_audio_path: string | null;
  system_audio_path: string | null;
  exact_source_fps: RecordingRational | null;
  source_frame_count: number | null;
  certified_tier: RecordingCertifiedTier | null;
  quality_verdict: RecordingQualityVerdict;
  bundle_path: string | null;
}

export interface RecordingBundleArtifactV2 {
  relative_path: string;
  bytes: number;
  sha256: string;
}

export interface RecordingBundleV2 {
  schema_version: typeof RECORDING_BUNDLE_SCHEMA_VERSION;
  status: "completed" | "quality_failed";
  created_at: string;
  delivery_policy: RecordingDeliveryPolicy;
  certified_tier: RecordingCertifiedTier | null;
  capture_contract: RecordingCaptureContractV2;
  master: RecordingBundleArtifactV2 & {
    relative_path: "master/video.mkv";
    codec: "ffv1";
    pixel_format: "bgra";
    frame_count: number;
    exact_fps: RecordingRational;
  };
  proxy:
    | (RecordingBundleArtifactV2 & {
        relative_path: "proxy/video.mp4";
        codec: "h264";
      })
    | null;
  audio: Array<RecordingBundleArtifactV2 & { role: "microphone" | "system"; codec: "pcm_s16le" }>;
  evidence: {
    cadence_path: "evidence/cadence.json";
    quality_path: "evidence/quality.json";
  };
  sidecars: {
    actions_path: "sidecars/actions.json" | null;
  };
  sequence_ledger_path: string;
  failure_codes: RecordingQualityFailureCode[];
}

export interface ExportRecordingSourceV2 {
  version: typeof RECORDING_COMPOSITION_SOURCE_VERSION;
  bundle_path: string;
  master_path: string;
  proxy_path: string;
  cadence_evidence_path: string;
  quality_evidence_path: string;
  exact_source_fps: RecordingRational;
  source_frame_count: number;
  master_width: number;
  master_height: number;
  quality_verdict: Extract<RecordingQualityVerdict, "passed" | "degraded">;
}

export interface CaptureBackendV2Capabilities {
  version: typeof RECORDING_CONTRACT_VERSION;
  backend_id: string;
  backend_version: string;
  target_classes: RecordingTargetClass[];
  supports_native_timestamps: boolean;
  supports_source_sequences: boolean;
  supports_physical_pixels: boolean;
  supports_cursor_policy: boolean;
  supports_pause_resume: boolean;
}

export interface CaptureBackendV2Frame {
  source_sequence: number;
  native_pts_us: number;
  width: number;
  height: number;
  stride: number;
  pixel_format: "bgra";
}

export interface CaptureBackendV2SessionStart {
  session_id: string;
  request: RecordingPreflightV2Request;
}

export interface CaptureBackendV2 {
  readonly capabilities: CaptureBackendV2Capabilities;
  probe(request: RecordingPreflightV2Request): Promise<RecordingPreflightV2Dto>;
  start(request: CaptureBackendV2SessionStart): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

const FAILURE_CODES = new Set<RecordingQualityFailureCode>([
  "source_rate_mismatch",
  "source_sequence_missing",
  "source_sequence_gap",
  "source_stale_reuse",
  "scheduled_slot_skipped",
  "submitted_frame_dropped",
  "encoder_deadline_missed",
  "frame_ring_overflow",
  "preflight_failed",
  "uncertified_tier",
  "backend_unavailable",
  "backend_capability_mismatch",
  "permission_denied",
  "target_missing",
  "target_ambiguous",
  "target_changed",
  "target_lost",
  "storage_estimate_failed",
  "storage_reserve_exhausted",
  "artifact_probe_failed",
  "artifact_frame_count_mismatch",
  "artifact_pts_gap",
  "artifact_pts_duplicate",
  "artifact_decode_failed",
  "artifact_truncated",
  "artifact_resolution_mismatch",
  "artifact_codec_mismatch",
  "artifact_hash_mismatch",
  "visual_full_frame_ssim",
  "visual_text_edge_ssim",
  "visual_edge_contrast",
  "visual_edge_spread",
  "visual_overlay_geometry",
  "visual_color_delta",
  "verification_timeout",
  "contract_mismatch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isRational(value: unknown): value is RecordingRational {
  return (
    isRecord(value) &&
    Number.isInteger(value.numerator) &&
    Number.isInteger(value.denominator) &&
    (value.denominator as number) > 0
  );
}

function isFailureCodes(value: unknown): value is RecordingQualityFailureCode[] {
  return Array.isArray(value) && value.every((code) => FAILURE_CODES.has(code));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecordingDimensions(value: unknown): value is RecordingDimensionsV2 {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value.logical_width) &&
    isPositiveInteger(value.logical_height) &&
    typeof value.capture_dpr === "number" &&
    Number.isFinite(value.capture_dpr) &&
    value.capture_dpr > 0 &&
    isPositiveInteger(value.physical_width) &&
    isPositiveInteger(value.physical_height) &&
    isPositiveInteger(value.requested_output_width) &&
    isPositiveInteger(value.requested_output_height)
  );
}

function isRecordingCaptureContract(value: unknown): value is RecordingCaptureContractV2 {
  return (
    isRecord(value) &&
    isExactStrictFrameRate(value.exact_fps) &&
    isRecordingDimensions(value.dimensions)
  );
}

function isRecordingCertifiedTier(value: unknown): value is RecordingCertifiedTier {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.stage === "shadow" ||
      value.stage === "internal" ||
      value.stage === "certified" ||
      value.stage === "disabled") &&
    (value.target_class === "browser" ||
      value.target_class === "display" ||
      value.target_class === "window") &&
    (value.platform === "darwin" || value.platform === "win32") &&
    typeof value.arch === "string" &&
    value.arch.length > 0 &&
    typeof value.backend_id === "string" &&
    value.backend_id.length > 0 &&
    typeof value.backend_version === "string" &&
    value.backend_version.length > 0 &&
    typeof value.hardware_fingerprint === "string" &&
    value.hardware_fingerprint.length > 0 &&
    isExactStrictFrameRate(value.exact_fps) &&
    isPositiveInteger(value.output_width) &&
    isPositiveInteger(value.output_height)
  );
}

function isBundleArtifact(value: unknown, relativePath: string): boolean {
  return (
    isRecord(value) &&
    value.relative_path === relativePath &&
    isPositiveInteger(value.bytes) &&
    isSha256(value.sha256)
  );
}

export function readRecordingDeliveryPolicy(value: unknown): RecordingDeliveryPolicy {
  return value === "strict" ? "strict" : "best_effort";
}

export function isExactStrictFrameRate(
  value: unknown,
): value is typeof STRICT_RECORDING_FRAME_RATE {
  return isRational(value) && value.numerator === 60 && value.denominator === 1;
}

export function readRecordingInfoV2(value: unknown): RecordingInfoV2 | null {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !isFiniteNonNegative(value.captured_at)
  ) {
    return null;
  }
  const v2 = value.version === RECORDING_CONTRACT_VERSION;
  return {
    version: RECORDING_CONTRACT_VERSION,
    path: value.path,
    captured_at: value.captured_at,
    duration_ms: isFiniteNonNegative(value.duration_ms) ? value.duration_ms : null,
    width: isPositiveInteger(value.width) ? value.width : null,
    height: isPositiveInteger(value.height) ? value.height : null,
    master_path: v2 && typeof value.master_path === "string" ? value.master_path : null,
    proxy_path: v2 && typeof value.proxy_path === "string" ? value.proxy_path : null,
    cadence_evidence_path:
      v2 && typeof value.cadence_evidence_path === "string" ? value.cadence_evidence_path : null,
    quality_evidence_path:
      v2 && typeof value.quality_evidence_path === "string" ? value.quality_evidence_path : null,
    actions_path: v2 && typeof value.actions_path === "string" ? value.actions_path : null,
    microphone_audio_path:
      v2 && typeof value.microphone_audio_path === "string" ? value.microphone_audio_path : null,
    system_audio_path:
      v2 && typeof value.system_audio_path === "string" ? value.system_audio_path : null,
    exact_source_fps: v2 && isRational(value.exact_source_fps) ? value.exact_source_fps : null,
    source_frame_count:
      v2 && isFiniteNonNegative(value.source_frame_count) ? value.source_frame_count : null,
    certified_tier:
      v2 && isRecordingCertifiedTier(value.certified_tier) ? value.certified_tier : null,
    quality_verdict:
      v2 &&
      (value.quality_verdict === "passed" ||
        value.quality_verdict === "degraded" ||
        value.quality_verdict === "failed")
        ? value.quality_verdict
        : "unknown",
    bundle_path: v2 && typeof value.bundle_path === "string" ? value.bundle_path : null,
  };
}

export function readRecordingBundleV2(value: unknown): RecordingBundleV2 | null {
  if (!isRecord(value) || value.schema_version !== RECORDING_BUNDLE_SCHEMA_VERSION) return null;
  if (value.status !== "completed" && value.status !== "quality_failed") return null;
  if (
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !isRecordingCaptureContract(value.capture_contract)
  ) {
    return null;
  }
  if (value.delivery_policy !== "strict" && value.delivery_policy !== "best_effort") return null;
  if (value.certified_tier !== null && !isRecordingCertifiedTier(value.certified_tier)) return null;
  if (!isRecord(value.master) || !isBundleArtifact(value.master, "master/video.mkv")) return null;
  const master = value.master;
  if (master.codec !== "ffv1" || master.pixel_format !== "bgra") return null;
  if (!isExactStrictFrameRate(master.exact_fps) || !isPositiveInteger(master.frame_count)) {
    return null;
  }
  if (
    value.proxy !== null &&
    (!isRecord(value.proxy) ||
      !isBundleArtifact(value.proxy, "proxy/video.mp4") ||
      value.proxy.codec !== "h264")
  ) {
    return null;
  }
  if (value.status === "completed" && value.proxy === null) return null;
  if (!isFailureCodes(value.failure_codes)) return null;
  if (!isRecord(value.evidence) || !isRecord(value.sidecars)) return null;
  if (value.evidence.cadence_path !== "evidence/cadence.json") return null;
  if (value.evidence.quality_path !== "evidence/quality.json") return null;
  if (
    value.sidecars.actions_path !== null &&
    value.sidecars.actions_path !== "sidecars/actions.json"
  ) {
    return null;
  }
  if (value.sequence_ledger_path !== "evidence/sequence-ledger.jsonl") return null;
  if (!Array.isArray(value.audio)) return null;
  const audioRoles = new Set<string>();
  for (const audio of value.audio) {
    if (!isRecord(audio) || (audio.role !== "microphone" && audio.role !== "system")) return null;
    if (audioRoles.has(audio.role)) return null;
    audioRoles.add(audio.role);
    if (!isBundleArtifact(audio, `audio/${audio.role}.wav`) || audio.codec !== "pcm_s16le") {
      return null;
    }
  }
  return value as unknown as RecordingBundleV2;
}

export function readExportRecordingSourceV2(value: unknown): ExportRecordingSourceV2 | null {
  if (!isRecord(value) || value.version !== RECORDING_COMPOSITION_SOURCE_VERSION) return null;
  const stringKeys = [
    "bundle_path",
    "master_path",
    "proxy_path",
    "cadence_evidence_path",
    "quality_evidence_path",
  ] as const;
  if (stringKeys.some((key) => typeof value[key] !== "string")) return null;
  if (!isExactStrictFrameRate(value.exact_source_fps)) return null;
  if (!isPositiveInteger(value.source_frame_count)) return null;
  if (!isPositiveInteger(value.master_width) || !isPositiveInteger(value.master_height))
    return null;
  if (value.quality_verdict !== "passed" && value.quality_verdict !== "degraded") return null;
  return value as unknown as ExportRecordingSourceV2;
}

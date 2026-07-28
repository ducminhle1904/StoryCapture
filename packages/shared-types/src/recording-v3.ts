import type {
  RecordingBundleArtifactV2,
  RecordingBundleV2,
  RecordingDeliveryPolicy,
  RecordingDimensionsV2,
  RecordingQualityFailureCode,
  RecordingQualityMetricV2,
  RecordingQualityVerdict,
  RecordingRational,
} from "@storycapture/shared-types/recording-v2";
import {
  isExactStrictFrameRate,
  readRecordingBundleV2,
} from "@storycapture/shared-types/recording-v2";

export const RECORDING_V3_CONTRACT_VERSION = 3 as const;
export const RECORDING_V3_BUNDLE_SCHEMA_VERSION = 3 as const;

export type RecordingBundle = RecordingBundleV2 | RecordingBundleV3;

export type RecordingV3FailureCode =
  | RecordingQualityFailureCode
  | "encoder_unavailable"
  | "encoder_rejected_frame"
  | "initial_surface_missing"
  | "output_pts_non_monotonic"
  | "artifact_finalize_failed";

const V3_FAILURE_CODES = new Set<RecordingV3FailureCode>([
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
  "encoder_unavailable",
  "encoder_rejected_frame",
  "initial_surface_missing",
  "output_pts_non_monotonic",
  "artifact_finalize_failed",
]);

export interface RecordingCadenceEvidenceV3 {
  version: typeof RECORDING_V3_CONTRACT_VERSION;
  requested_fps: RecordingRational;
  active_duration_us: number;
  source_updates: number;
  output_frames: number;
  held_frames: number;
  encoder_dropped_frames: number;
  backpressure_events: number;
  unresolved_backpressure_events: number;
  pts_gaps: number;
  pts_duplicates: number;
  pts_non_monotonic: number;
  initial_surface_received: boolean;
  verdict: RecordingQualityVerdict;
  failure_codes: RecordingV3FailureCode[];
}

export interface RecordingQualityEvidenceV3 {
  version: typeof RECORDING_V3_CONTRACT_VERSION;
  evaluated_frames: number;
  full_frame_luma_ssim: RecordingQualityMetricV2 | null;
  text_edge_roi_ssim: RecordingQualityMetricV2 | null;
  p01_edge_contrast_retention: RecordingQualityMetricV2 | null;
  edge_spread_increase_px: RecordingQualityMetricV2 | null;
  overlay_geometry_delta_px: RecordingQualityMetricV2 | null;
  color_channel_delta: RecordingQualityMetricV2 | null;
  lossless_master_hashes: "not_applicable";
  verdict: RecordingQualityVerdict;
  failure_codes: RecordingV3FailureCode[];
}

export interface RecordingBundleV3 {
  schema_version: typeof RECORDING_V3_BUNDLE_SCHEMA_VERSION;
  status: "completed" | "quality_failed";
  created_at: string;
  delivery_policy: RecordingDeliveryPolicy;
  capture_contract: {
    requested_fps: RecordingRational;
    verified_fps: RecordingRational;
    dimensions: RecordingDimensionsV2;
  };
  master: RecordingBundleArtifactV2 & {
    relative_path: "master/video.mp4";
    codec: "h264";
    pixel_format: "yuv420p" | "nv12";
    frame_count: number;
    exact_fps: RecordingRational;
    native_capture_backend: { id: string; version: string };
    native_encoder: { id: string; hardware_accelerated: true };
    started_monotonic_us: number;
    ended_monotonic_us: number;
    finalized_duration_us: number;
  };
  proxy:
    | (RecordingBundleArtifactV2 & {
        relative_path: "proxy/video.mp4";
        codec: "h264";
      })
    | null;
  audio: Array<RecordingBundleArtifactV2 & { role: "microphone" | "system"; codec: "pcm_s16le" }>;
  cadence: RecordingCadenceEvidenceV3;
  artifact: {
    finalized: boolean;
    full_decode_succeeded: boolean;
    decoded_frames: number;
  };
  quality: RecordingQualityEvidenceV3;
  evidence: {
    cadence_path: "evidence/cadence.json";
    quality_path: "evidence/quality.json";
  };
  sidecars: {
    actions_path: "sidecars/actions.json" | null;
  };
  sequence_ledger_path: "evidence/sequence-ledger.jsonl";
  failure_codes: RecordingV3FailureCode[];
}

export interface RecordingResultV3Base {
  version: typeof RECORDING_V3_CONTRACT_VERSION;
  delivery_policy: RecordingDeliveryPolicy;
  bundle_path: string;
  output_path: string | null;
  diagnostic_bundle_path: string | null;
  duration_ms: number;
  bytes: number;
  master_path: string;
  proxy_path: string | null;
  cadence_evidence: RecordingCadenceEvidenceV3;
  quality_evidence: RecordingQualityEvidenceV3;
}

export type RecordingResultV3 =
  | (RecordingResultV3Base & {
      status: "completed";
      output_path: string;
      diagnostic_bundle_path: null;
    })
  | (RecordingResultV3Base & {
      status: "quality_failed";
      output_path: null;
      diagnostic_bundle_path: string;
    });

export type RecordingEventV3 =
  | { type: "preflight"; result: RecordingNativePreflightV3 }
  | {
      type: "readiness";
      state: "global_ready" | "target_ready" | "initial_surface_received";
    }
  | { type: "live-evidence"; evidence: RecordingCadenceEvidenceV3 }
  | { type: "verifying"; progress: number }
  | { type: "completed"; result: RecordingResultV3 & { status: "completed" } }
  | { type: "quality-failed"; result: RecordingResultV3 & { status: "quality_failed" } }
  | { type: "failed"; message: string; reason?: RecordingV3FailureCode }
  | { type: "audio-unavailable"; reason: string }
  | { type: "heartbeat"; seq: number };

export interface RecordingNativePreflightV3 {
  version: typeof RECORDING_V3_CONTRACT_VERSION;
  platform: "darwin" | "win32";
  helper_available: boolean;
  protocol_compatible: boolean;
  permission: "granted" | "denied" | "not_determined";
  encoder_available: boolean;
  encoder_id: string | null;
  hardware_accelerated: boolean;
  storage_available_bytes: number;
  storage_required_bytes: number;
  policy_allowed: boolean;
  strict_eligible: boolean;
  failure_codes: RecordingV3FailureCode[];
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

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isArtifact(value: unknown, relativePath: string): boolean {
  return (
    isRecord(value) &&
    value.relative_path === relativePath &&
    isPositiveInteger(value.bytes) &&
    isSha256(value.sha256)
  );
}

function isDimensions(value: unknown): value is RecordingDimensionsV2 {
  return (
    isRecord(value) &&
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

function isFailureCodes(value: unknown): value is RecordingV3FailureCode[] {
  return Array.isArray(value) && value.every((code) => V3_FAILURE_CODES.has(code));
}

function isMetric(value: unknown): value is RecordingQualityMetricV2 {
  return (
    isRecord(value) &&
    typeof value.measured === "number" &&
    Number.isFinite(value.measured) &&
    typeof value.threshold === "number" &&
    Number.isFinite(value.threshold) &&
    (value.comparator === "gte" || value.comparator === "lte") &&
    typeof value.passed === "boolean"
  );
}

function isVerdict(value: unknown): value is RecordingQualityVerdict {
  return value === "passed" || value === "degraded" || value === "failed" || value === "unknown";
}

function isCadence(value: unknown): value is RecordingCadenceEvidenceV3 {
  if (!isRecord(value) || value.version !== RECORDING_V3_CONTRACT_VERSION) return false;
  return (
    isExactStrictFrameRate(value.requested_fps) &&
    isNonNegativeInteger(value.active_duration_us) &&
    isNonNegativeInteger(value.source_updates) &&
    isPositiveInteger(value.output_frames) &&
    isNonNegativeInteger(value.held_frames) &&
    value.held_frames <= value.output_frames &&
    isNonNegativeInteger(value.encoder_dropped_frames) &&
    isNonNegativeInteger(value.backpressure_events) &&
    isNonNegativeInteger(value.unresolved_backpressure_events) &&
    isNonNegativeInteger(value.pts_gaps) &&
    isNonNegativeInteger(value.pts_duplicates) &&
    isNonNegativeInteger(value.pts_non_monotonic) &&
    typeof value.initial_surface_received === "boolean" &&
    isVerdict(value.verdict) &&
    isFailureCodes(value.failure_codes)
  );
}

function isQuality(value: unknown): value is RecordingQualityEvidenceV3 {
  if (!isRecord(value) || value.version !== RECORDING_V3_CONTRACT_VERSION) return false;
  const metrics = [
    value.full_frame_luma_ssim,
    value.text_edge_roi_ssim,
    value.p01_edge_contrast_retention,
    value.edge_spread_increase_px,
    value.overlay_geometry_delta_px,
    value.color_channel_delta,
  ];
  return (
    isNonNegativeInteger(value.evaluated_frames) &&
    metrics.every((metric) => metric === null || isMetric(metric)) &&
    value.lossless_master_hashes === "not_applicable" &&
    isVerdict(value.verdict) &&
    isFailureCodes(value.failure_codes)
  );
}

export function readRecordingBundleV3(value: unknown): RecordingBundleV3 | null {
  if (!isRecord(value) || value.schema_version !== RECORDING_V3_BUNDLE_SCHEMA_VERSION) return null;
  if (value.status !== "completed" && value.status !== "quality_failed") return null;
  if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
    return null;
  }
  if (value.delivery_policy !== "strict" && value.delivery_policy !== "best_effort") return null;
  if (!isRecord(value.capture_contract)) return null;
  if (
    !isExactStrictFrameRate(value.capture_contract.requested_fps) ||
    !isExactStrictFrameRate(value.capture_contract.verified_fps) ||
    !isDimensions(value.capture_contract.dimensions)
  ) {
    return null;
  }
  if (!isRecord(value.master) || !isArtifact(value.master, "master/video.mp4")) return null;
  const master = value.master;
  if (
    master.codec !== "h264" ||
    (master.pixel_format !== "yuv420p" && master.pixel_format !== "nv12") ||
    !isPositiveInteger(master.frame_count) ||
    !isExactStrictFrameRate(master.exact_fps) ||
    !isRecord(master.native_capture_backend) ||
    typeof master.native_capture_backend.id !== "string" ||
    typeof master.native_capture_backend.version !== "string" ||
    !isRecord(master.native_encoder) ||
    typeof master.native_encoder.id !== "string" ||
    master.native_encoder.hardware_accelerated !== true ||
    !isNonNegativeInteger(master.started_monotonic_us) ||
    !isPositiveInteger(master.ended_monotonic_us) ||
    master.ended_monotonic_us <= master.started_monotonic_us ||
    !isPositiveInteger(master.finalized_duration_us)
  ) {
    return null;
  }
  if (
    value.proxy !== null &&
    (!isRecord(value.proxy) ||
      !isArtifact(value.proxy, "proxy/video.mp4") ||
      value.proxy.codec !== "h264")
  ) {
    return null;
  }
  if (!isCadence(value.cadence) || value.cadence.output_frames !== master.frame_count) return null;
  if (
    !isRecord(value.artifact) ||
    typeof value.artifact.finalized !== "boolean" ||
    typeof value.artifact.full_decode_succeeded !== "boolean" ||
    !isNonNegativeInteger(value.artifact.decoded_frames)
  ) {
    return null;
  }
  if (!isQuality(value.quality) || !isFailureCodes(value.failure_codes)) return null;
  if (!isRecord(value.evidence) || !isRecord(value.sidecars)) return null;
  if (
    value.evidence.cadence_path !== "evidence/cadence.json" ||
    value.evidence.quality_path !== "evidence/quality.json" ||
    (value.sidecars.actions_path !== null &&
      value.sidecars.actions_path !== "sidecars/actions.json") ||
    value.sequence_ledger_path !== "evidence/sequence-ledger.jsonl"
  ) {
    return null;
  }
  if (!Array.isArray(value.audio)) return null;
  const roles = new Set<string>();
  for (const audio of value.audio) {
    if (!isRecord(audio) || (audio.role !== "microphone" && audio.role !== "system")) return null;
    if (roles.has(audio.role) || !isArtifact(audio, `audio/${audio.role}.wav`)) return null;
    if (audio.codec !== "pcm_s16le") return null;
    roles.add(audio.role);
  }
  if (
    value.status === "completed" &&
    (!value.artifact.finalized ||
      !value.artifact.full_decode_succeeded ||
      value.artifact.decoded_frames !== master.frame_count ||
      value.cadence.verdict !== "passed" ||
      value.quality.verdict !== "passed" ||
      value.cadence.failure_codes.length > 0 ||
      value.quality.failure_codes.length > 0 ||
      value.failure_codes.length > 0)
  ) {
    return null;
  }
  if (
    value.status === "quality_failed" &&
    value.cadence.verdict === "passed" &&
    value.quality.verdict === "passed" &&
    value.cadence.failure_codes.length === 0 &&
    value.quality.failure_codes.length === 0 &&
    value.failure_codes.length === 0
  ) {
    return null;
  }
  return value as unknown as RecordingBundleV3;
}

export function readRecordingBundle(value: unknown): RecordingBundle | null {
  if (!isRecord(value)) return null;
  if (value.schema_version === 2) return readRecordingBundleV2(value);
  if (value.schema_version === RECORDING_V3_BUNDLE_SCHEMA_VERSION) {
    return readRecordingBundleV3(value);
  }
  return null;
}

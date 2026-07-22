import type {
  RecordingBundleArtifactV2,
  RecordingCertificationStage,
  RecordingDimensionsV2,
  RecordingPlatform,
  RecordingQualityMetricV2,
  RecordingQualityVerdict,
  RecordingRational,
  RecordingSourceRateProbeV2,
  RecordingStorageEstimateV2,
  RecordingTargetClass,
} from "./recording-v2";

export const RECORDING_CONTRACT_VERSION_V3 = 3 as const;
export const RECORDING_BUNDLE_SCHEMA_VERSION_V3 = 3 as const;
export const RECORDING_COMPOSITION_SOURCE_VERSION_V3 = 3 as const;
export const RECORDING_CERTIFICATION_MANIFEST_SCHEMA_VERSION_V3 = 1 as const;
export const RECORDING_CERTIFICATION_CANONICALIZATION_V3 = "RFC8785" as const;
export const RECORDING_CERTIFICATION_SIGNATURE_ALGORITHM_V3 = "ed25519" as const;
export const RECORDING_GUARANTEE_BOUNDARY_V3 = "electron_offscreen_delivery" as const;
export const RECORDING_SOURCE_ORDINAL_KIND_V3 = "electron_frame_count" as const;
export const RECORDING_CURSOR_POLICY_V3 = "sidecar_reconstructed" as const;
export const RECORDING_V3_STRICT_DIMENSIONS = {
  logical_width: 960,
  logical_height: 540,
  capture_dpr: 2,
  physical_width: 1920,
  physical_height: 1080,
  requested_output_width: 1920,
  requested_output_height: 1080,
} as const satisfies RecordingDimensionsV2;
export const RECORDING_V3_LOCAL_DIMENSION_LIMITS = {
  minimum_width: 320,
  maximum_width: 1920,
  minimum_height: 240,
  maximum_height: 1080,
  maximum_physical_pixels: 1920 * 1080,
  capture_dpr: 1,
} as const;

export type RecordingGuaranteeBoundaryV3 = typeof RECORDING_GUARANTEE_BOUNDARY_V3;
export type RecordingSourceOrdinalKindV3 = typeof RECORDING_SOURCE_ORDINAL_KIND_V3;
export type RecordingCursorPolicyV3 = typeof RECORDING_CURSOR_POLICY_V3;
export type RecordingMeasurementScopeV3 = "runtime_integrity" | "certification_fixture";
export type RecordingAudioRoleV3 = "microphone" | "system";
export type RecordingV3EnforcementMode = "strict";
export type RecordingV3CertificationMode = "local" | "certified";
export type RecordingV3DeliveryPolicy = "strict";
export type RecordingV3Mode = "strict_local" | "strict_certified";
export type LegacyRecordingV3Intent = "strict" | "development";
export type LegacyRecordingV3DeliveryPolicy = "strict" | "development";
export type LegacyRecordingV3Mode = "certified" | "uncertified_development";

export interface LegacyRecordingV3Provenance {
  delivery_policy: LegacyRecordingV3DeliveryPolicy;
  recording_mode?: LegacyRecordingV3Mode;
}

export interface RecordingV3DimensionValidation {
  valid: boolean;
  detail: string | null;
}

export type RecordingFailureCodeV3 =
  | "source_metadata_missing"
  | "source_metadata_invalid"
  | "source_ordinal_gap"
  | "source_timestamp_regression"
  | "unverified_guarantee_boundary"
  | "source_epoch_violation"
  | "active_segment_violation"
  | "native_lease_overflow"
  | "native_backpressure"
  | "native_deadline_missed"
  | "native_texture_lost"
  | "native_addon_crashed"
  | "native_encoder_exit_nonzero"
  | "addon_load_failed"
  | "addon_protocol_mismatch"
  | "addon_hash_mismatch"
  | "manifest_missing"
  | "manifest_signature_invalid"
  | "manifest_expired"
  | "manifest_not_yet_valid"
  | "profile_mismatch"
  | "profile_expired"
  | "tier_kill_switch_disabled"
  | "unsupported_audio_role"
  | "permission_denied"
  | "storage_preflight_failed"
  | "target_unsupported"
  | "target_lost"
  | "artifact_verification_failed"
  | "runtime_integrity_failed"
  | "contract_mismatch";

export const RECORDING_V3_FAILURE_MESSAGES: Readonly<Record<RecordingFailureCodeV3, string>> = {
  source_metadata_missing: "The browser did not provide verifiable frame metadata.",
  source_metadata_invalid: "The browser frame metadata did not satisfy the Strict contract.",
  source_ordinal_gap: "The browser presentation sequence contains a gap.",
  source_timestamp_regression: "The browser presentation timestamp moved backwards.",
  unverified_guarantee_boundary: "The capture source cannot prove the Strict guarantee boundary.",
  source_epoch_violation: "The browser source epoch changed unexpectedly.",
  active_segment_violation: "The active recording segment changed unexpectedly.",
  native_lease_overflow: "The native texture lease queue exceeded its Strict bound.",
  native_backpressure: "The native encoder could not sustain the Strict frame rate.",
  native_deadline_missed: "The native frame path missed its Strict deadline.",
  native_texture_lost: "The native frame path lost a browser texture.",
  native_addon_crashed: "The native Recording V3 engine stopped unexpectedly.",
  native_encoder_exit_nonzero: "The lossless native encoder exited unsuccessfully.",
  addon_load_failed: "The native Recording V3 engine is unavailable.",
  addon_protocol_mismatch: "The native Recording V3 engine protocol is not supported.",
  addon_hash_mismatch: "The native Recording V3 engine does not match the certified binary.",
  manifest_missing: "This build does not include a Recording V3 certification manifest.",
  manifest_signature_invalid: "The Recording V3 certification manifest signature is invalid.",
  manifest_expired: "The Recording V3 certification manifest has expired.",
  manifest_not_yet_valid: "The Recording V3 certification manifest is not valid yet.",
  profile_mismatch: "This hardware and runtime do not exactly match a certified profile.",
  profile_expired: "The matching Recording V3 certification profile has expired.",
  tier_kill_switch_disabled: "The matching Recording V3 profile is disabled by its kill switch.",
  unsupported_audio_role: "Strict Recording V3 does not support the selected audio source.",
  permission_denied: "A required capture permission is not granted.",
  storage_preflight_failed: "Available storage is below the Strict Recording V3 reserve.",
  target_unsupported: "Strict Recording V3 currently supports browser author-preview targets only.",
  target_lost: "The authoritative browser recording target was lost.",
  artifact_verification_failed: "The recorded master failed full artifact verification.",
  runtime_integrity_failed: "Runtime evidence did not satisfy the Strict Recording V3 contract.",
  contract_mismatch: "The Recording V3 request does not match the selected Strict contract.",
};

export function recordingV3FailureMessage(code: RecordingFailureCodeV3): string {
  return RECORDING_V3_FAILURE_MESSAGES[code];
}

export interface RecordingCertifiedProfileV3 {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  profile_id: string;
  stage: RecordingCertificationStage;
  target_class: RecordingTargetClass;
  platform: RecordingPlatform;
  arch: string;
  hardware_model: string;
  hardware_chip: string;
  os_build: string;
  backend_id: string;
  backend_version: string;
  addon_protocol_version: number;
  addon_sha256: string;
  electron_version: string;
  chromium_version: string;
  ffmpeg_version: string;
  ffmpeg_sha256: string;
  output_width: number;
  output_height: number;
  exact_fps: RecordingRational;
  cursor_policy: RecordingCursorPolicyV3;
  audio_roles: [];
  evidence_artifact_sha256: string;
  valid_from: string;
  valid_until: string;
  kill_switch_id: string;
}

export interface RecordingCertificationManifestPayloadV3 {
  schema_version: typeof RECORDING_CERTIFICATION_MANIFEST_SCHEMA_VERSION_V3;
  manifest_id: string;
  canonicalization: typeof RECORDING_CERTIFICATION_CANONICALIZATION_V3;
  signature_algorithm: typeof RECORDING_CERTIFICATION_SIGNATURE_ALGORITHM_V3;
  signer_key_id: string;
  issued_at: string;
  valid_from: string;
  valid_until: string;
  disabled_kill_switch_ids: string[];
  profiles: RecordingCertifiedProfileV3[];
}

export interface SignedRecordingCertificationManifestV3 {
  payload: RecordingCertificationManifestPayloadV3;
  signature: string;
}

export interface RecordingCaptureContractV3 {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  guarantee_boundary: RecordingGuaranteeBoundaryV3;
  source_ordinal_kind: RecordingSourceOrdinalKindV3;
  target_class: RecordingTargetClass;
  exact_fps: RecordingRational;
  dimensions: RecordingDimensionsV2;
  cursor_policy: RecordingCursorPolicyV3;
  audio_roles: [];
}

export interface RecordingPreflightV3Request {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  enforcement_mode: RecordingV3EnforcementMode;
  certification_mode: RecordingV3CertificationMode;
  target_class: RecordingTargetClass;
  requested_fps: RecordingRational;
  dimensions: RecordingDimensionsV2;
  cursor_policy: RecordingCursorPolicyV3;
  audio_roles: RecordingAudioRoleV3[];
}

export interface RecordingPreflightV3Dto {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  enforcement_mode: RecordingV3EnforcementMode;
  certification_mode: RecordingV3CertificationMode;
  recording_mode: RecordingV3Mode;
  backend_id: string;
  backend_version: string;
  addon_protocol_version: number;
  platform: RecordingPlatform;
  arch: string;
  hardware_model: string;
  hardware_chip: string;
  os_build: string;
  manifest_id: string | null;
  matched_profile: RecordingCertifiedProfileV3 | null;
  source_rate: RecordingSourceRateProbeV2;
  storage: RecordingStorageEstimateV2;
  native_probe_passed: boolean;
  permissions_granted: boolean;
  runtime_eligible: boolean;
  certification_eligible: boolean;
  eligible: boolean;
  failure_codes: RecordingFailureCodeV3[];
}

export interface RecordingFrameLedgerEntryV3 {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  source_epoch: number;
  active_segment: number;
  source_frame_count: number;
  source_timestamp_us: number;
  active_time_pts_us: number;
  delivery_ordinal: number;
  native_lease_ordinal: number;
  native_commit_ordinal: number;
  encoded_ordinal: number;
  decoded_ordinal: number;
  bgra_sha256: string;
}

export interface RecordingDiagnosticFrameLedgerEntryV3
  extends Omit<RecordingFrameLedgerEntryV3, "decoded_ordinal"> {
  decoded_ordinal: null;
  failure_codes: RecordingFailureCodeV3[];
}

export interface RecordingCadenceEvidenceV3 {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  guarantee_boundary: RecordingGuaranteeBoundaryV3;
  source_ordinal_kind: RecordingSourceOrdinalKindV3;
  requested_fps: RecordingRational;
  source_fps: RecordingRational | null;
  stream_time_base: RecordingRational | null;
  active_duration_us: number;
  expected_slots: number;
  source_presentations: number;
  delivery_frames: number;
  native_commits: number;
  encoded_frames: number;
  artifact_decoded_frames: number;
  source_ordinal_gaps: number;
  source_timestamp_regressions: number;
  delivery_duplicates: number;
  native_lease_overflows: number;
  native_backpressure_events: number;
  native_deadline_misses: number;
  artifact_pts_gaps: number;
  artifact_pts_duplicates: number;
  full_decode_succeeded: boolean;
  verdict: RecordingQualityVerdict;
  failure_codes: RecordingFailureCodeV3[];
}

export interface RecordingFixtureReferenceV3 {
  fixture_id: string;
  fixture_version: string;
  reference_sha256: string;
}

export interface RecordingQualityEvidenceV3 {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  measurement_scope: RecordingMeasurementScopeV3;
  reference_identity: RecordingFixtureReferenceV3 | null;
  evaluated_frames: number;
  full_frame_luma_ssim: RecordingQualityMetricV2 | null;
  text_edge_roi_ssim: RecordingQualityMetricV2 | null;
  p01_edge_contrast_retention: RecordingQualityMetricV2 | null;
  edge_spread_increase_px: RecordingQualityMetricV2 | null;
  overlay_geometry_delta_px: RecordingQualityMetricV2 | null;
  color_channel_delta: RecordingQualityMetricV2 | null;
  lossless_master_hashes_match: boolean | null;
  certification_verdict: "passed" | "failed" | null;
  verdict: RecordingQualityVerdict;
  failure_codes: RecordingFailureCodeV3[];
}

export interface RecordingCertificationProfileReferenceV3 {
  manifest_id: string;
  profile_id: string;
  evidence_artifact_sha256: string;
}

export type RecordingV3Qualification =
  | { mode: "strict_local" }
  | {
      mode: "strict_certified";
      manifestId: string;
      profile: RecordingCertifiedProfileV3;
    };

export interface RecordingResultV3Base {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  delivery_policy: RecordingV3DeliveryPolicy;
  recording_mode: RecordingV3Mode;
  guarantee_boundary: RecordingGuaranteeBoundaryV3;
  certification_profile: RecordingCertificationProfileReferenceV3 | null;
  bundle_path: string;
  output_path: string | null;
  diagnostic_bundle_path: string | null;
  duration_ms: number;
  bytes: number;
  output_width: number;
  output_height: number;
  master_path: string | null;
  proxy_path: string | null;
  cadence_evidence: RecordingCadenceEvidenceV3;
  quality_evidence: RecordingQualityEvidenceV3;
}

export type RecordingResultV3 =
  | (RecordingResultV3Base & {
      status: "completed";
      delivery_policy: "strict";
      recording_mode: "strict_certified";
      certification_profile: RecordingCertificationProfileReferenceV3;
      output_path: string;
      diagnostic_bundle_path: null;
    })
  | (RecordingResultV3Base & {
      status: "completed";
      delivery_policy: "strict";
      recording_mode: "strict_local";
      certification_profile: null;
      output_path: string;
      diagnostic_bundle_path: null;
    })
  | (RecordingResultV3Base & {
      status: "quality_failed";
      delivery_policy: "strict";
      recording_mode: "strict_certified";
      output_path: null;
      diagnostic_bundle_path: string;
    })
  | (RecordingResultV3Base & {
      status: "quality_failed";
      delivery_policy: "strict";
      recording_mode: "strict_local";
      certification_profile: null;
      output_path: null;
      diagnostic_bundle_path: string;
    });

export type RecordingEventV3 =
  | { type: "preflight"; result: RecordingPreflightV3Dto }
  | {
      type: "readiness";
      state: "source_ready" | "first_frame_committed" | "pre_input_frame_committed";
    }
  | { type: "live-evidence"; evidence: RecordingCadenceEvidenceV3 }
  | { type: "verifying"; progress: number }
  | { type: "completed"; result: RecordingResultV3 & { status: "completed" } }
  | { type: "quality-failed"; result: RecordingResultV3 & { status: "quality_failed" } }
  | { type: "failed"; message: string; failure_codes: RecordingFailureCodeV3[] }
  | { type: "heartbeat"; seq: number };

export type RecordingHostLifecycleV3 =
  | "recording"
  | "paused"
  | "stopping"
  | "terminal_unacknowledged";

export interface RecordingHostSessionSnapshotV3 {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  id: string;
  project_folder: string;
  started_at_ms: number;
  lifecycle: RecordingHostLifecycleV3;
  preflight: RecordingPreflightV3Dto;
  result: RecordingResultV3 | null;
  failure_codes: RecordingFailureCodeV3[];
  failure_message: string | null;
  updated_at: string;
}

export interface RecordingInfoV3 {
  version: typeof RECORDING_CONTRACT_VERSION_V3;
  path: string;
  captured_at: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  master_path: string | null;
  proxy_path: string | null;
  cadence_evidence_path: string | null;
  quality_evidence_path: string | null;
  frame_ledger_path: string | null;
  actions_path: string | null;
  cursor_path: string | null;
  exact_source_fps: RecordingRational | null;
  source_frame_count: number | null;
  recording_mode: RecordingV3Mode;
  certification_profile: RecordingCertificationProfileReferenceV3 | null;
  guarantee_boundary: RecordingGuaranteeBoundaryV3;
  source_scope_verified: true;
  quality_verdict: RecordingQualityVerdict;
  bundle_path: string | null;
}

export interface RecordingBundleV3Base {
  schema_version: typeof RECORDING_BUNDLE_SCHEMA_VERSION_V3;
  created_at: string;
  capture_contract: RecordingCaptureContractV3;
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
  audio: [];
  evidence: {
    cadence_path: "evidence/cadence.json";
    runtime_quality_path: "evidence/runtime-quality.json";
    certification_quality_path: "evidence/certification-quality.json" | null;
  };
  sidecars: {
    actions_path: "sidecars/actions.json" | null;
    cursor_path: "sidecars/cursor.json" | null;
  };
  frame_ledger_path: "evidence/frame-ledger.jsonl";
  diagnostics_manifest_path: "diagnostics/manifest.json";
  failure_codes: RecordingFailureCodeV3[];
}

export type RecordingBundleV3 = RecordingBundleV3Base &
  (
    | {
        status: "completed";
        delivery_policy: "strict";
        recording_mode: "strict_certified";
        certification_profile: RecordingCertificationProfileReferenceV3;
      }
    | {
        status: "quality_failed";
        delivery_policy: "strict";
        recording_mode: "strict_certified";
        certification_profile: RecordingCertificationProfileReferenceV3 | null;
      }
    | {
        status: "completed" | "quality_failed";
        delivery_policy: "strict";
        recording_mode: "strict_local";
        certification_profile: null;
      }
  );

export interface ExportRecordingSourceV3 {
  version: typeof RECORDING_COMPOSITION_SOURCE_VERSION_V3;
  bundle_path: string;
  master_path: string;
  proxy_path: string;
  cadence_evidence_path: string;
  quality_evidence_path: string;
  frame_ledger_path: string;
  exact_source_fps: RecordingRational;
  source_frame_count: number;
  master_width: number;
  master_height: number;
  quality_verdict: Extract<RecordingQualityVerdict, "passed" | "degraded">;
  guarantee_boundary: RecordingGuaranteeBoundaryV3;
  source_scope_verified: true;
  recording_mode: RecordingV3Mode;
  certification_profile_id: string | null;
}

const FAILURE_CODES_V3 = new Set<RecordingFailureCodeV3>([
  "source_metadata_missing",
  "source_metadata_invalid",
  "source_ordinal_gap",
  "source_timestamp_regression",
  "unverified_guarantee_boundary",
  "source_epoch_violation",
  "active_segment_violation",
  "native_lease_overflow",
  "native_backpressure",
  "native_deadline_missed",
  "native_texture_lost",
  "native_addon_crashed",
  "native_encoder_exit_nonzero",
  "addon_load_failed",
  "addon_protocol_mismatch",
  "addon_hash_mismatch",
  "manifest_missing",
  "manifest_signature_invalid",
  "manifest_expired",
  "manifest_not_yet_valid",
  "profile_mismatch",
  "profile_expired",
  "tier_kill_switch_disabled",
  "unsupported_audio_role",
  "permission_denied",
  "storage_preflight_failed",
  "target_unsupported",
  "target_lost",
  "artifact_verification_failed",
  "runtime_integrity_failed",
  "contract_mismatch",
]);

const PROFILE_KEYS = [
  "version",
  "profile_id",
  "stage",
  "target_class",
  "platform",
  "arch",
  "hardware_model",
  "hardware_chip",
  "os_build",
  "backend_id",
  "backend_version",
  "addon_protocol_version",
  "addon_sha256",
  "electron_version",
  "chromium_version",
  "ffmpeg_version",
  "ffmpeg_sha256",
  "output_width",
  "output_height",
  "exact_fps",
  "cursor_policy",
  "audio_roles",
  "evidence_artifact_sha256",
  "valid_from",
  "valid_until",
  "kill_switch_id",
] as const;

const MANIFEST_PAYLOAD_KEYS = [
  "schema_version",
  "manifest_id",
  "canonicalization",
  "signature_algorithm",
  "signer_key_id",
  "issued_at",
  "valid_from",
  "valid_until",
  "disabled_kill_switch_ids",
  "profiles",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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

function isBase64Signature(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[A-Za-z0-9+/]{4}){21}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(value)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRational(value: unknown): value is RecordingRational {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.numerator) &&
    Number.isSafeInteger(value.denominator) &&
    (value.numerator as number) > 0 &&
    (value.denominator as number) > 0
  );
}

function isExactStrictFrameRate(value: unknown): value is RecordingRational {
  return isRational(value) && value.numerator === 60 && value.denominator === 1;
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

function formatRecordingV3Dimensions(dimensions: RecordingDimensionsV2): string {
  return `${dimensions.logical_width}×${dimensions.logical_height} @${dimensions.capture_dpr}x -> ${dimensions.requested_output_width}×${dimensions.requested_output_height}`;
}

export function recordingV3DimensionsForViewport(
  certificationMode: RecordingV3CertificationMode,
  viewport: { width: number; height: number },
): RecordingDimensionsV2 {
  const captureDpr =
    certificationMode === "certified" ? RECORDING_V3_STRICT_DIMENSIONS.capture_dpr : 1;
  const physicalWidth = viewport.width * captureDpr;
  const physicalHeight = viewport.height * captureDpr;
  return {
    logical_width: viewport.width,
    logical_height: viewport.height,
    capture_dpr: captureDpr,
    physical_width: physicalWidth,
    physical_height: physicalHeight,
    requested_output_width: physicalWidth,
    requested_output_height: physicalHeight,
  };
}

export function validateRecordingV3Dimensions(
  certificationMode: RecordingV3CertificationMode,
  dimensions: RecordingDimensionsV2,
): RecordingV3DimensionValidation {
  const received = formatRecordingV3Dimensions(dimensions);
  if (!isDimensions(dimensions)) {
    return {
      valid: false,
      detail: `Recording V3 dimensions must be positive finite integers; received ${received}.`,
    };
  }

  if (certificationMode === "certified") {
    const valid = Object.entries(RECORDING_V3_STRICT_DIMENSIONS).every(
      ([key, value]) => dimensions[key as keyof RecordingDimensionsV2] === value,
    );
    return valid
      ? { valid: true, detail: null }
      : {
          valid: false,
          detail: `Strict Recording V3 requires ${formatRecordingV3Dimensions(RECORDING_V3_STRICT_DIMENSIONS)}; received ${received}.`,
        };
  }

  const limits = RECORDING_V3_LOCAL_DIMENSION_LIMITS;
  const logicalDimensionsAreEven =
    dimensions.logical_width % 2 === 0 && dimensions.logical_height % 2 === 0;
  const logicalDimensionsAreBounded =
    dimensions.logical_width >= limits.minimum_width &&
    dimensions.logical_width <= limits.maximum_width &&
    dimensions.logical_height >= limits.minimum_height &&
    dimensions.logical_height <= limits.maximum_height;
  const dimensionsAreConsistent =
    dimensions.capture_dpr === limits.capture_dpr &&
    dimensions.physical_width === dimensions.logical_width &&
    dimensions.physical_height === dimensions.logical_height &&
    dimensions.requested_output_width === dimensions.physical_width &&
    dimensions.requested_output_height === dimensions.physical_height;
  const physicalPixelsAreBounded =
    dimensions.physical_width * dimensions.physical_height <= limits.maximum_physical_pixels;

  if (
    logicalDimensionsAreEven &&
    logicalDimensionsAreBounded &&
    dimensionsAreConsistent &&
    physicalPixelsAreBounded
  ) {
    return { valid: true, detail: null };
  }

  return {
    valid: false,
    detail: `Strict Local Recording V3 requires an even viewport from ${limits.minimum_width}×${limits.minimum_height} through ${limits.maximum_width}×${limits.maximum_height} at DPR ${limits.capture_dpr}, matching physical/output dimensions, and at most ${limits.maximum_physical_pixels} physical pixels; received ${received}.`,
  };
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

function isQualityVerdict(value: unknown): value is RecordingQualityVerdict {
  return value === "passed" || value === "degraded" || value === "failed" || value === "unknown";
}

function isFailureCodes(value: unknown): value is RecordingFailureCodeV3[] {
  return Array.isArray(value) && value.every((code) => FAILURE_CODES_V3.has(code));
}

function isBundleArtifact(
  value: unknown,
  relativePath: string,
): value is RecordingBundleArtifactV2 {
  return (
    isRecord(value) &&
    value.relative_path === relativePath &&
    isPositiveInteger(value.bytes) &&
    isSha256(value.sha256)
  );
}

function isProfileReference(value: unknown): value is RecordingCertificationProfileReferenceV3 {
  return (
    isRecord(value) &&
    isNonEmptyString(value.manifest_id) &&
    isNonEmptyString(value.profile_id) &&
    isSha256(value.evidence_artifact_sha256)
  );
}

export function recordingV3ModeForCertificationMode(
  certificationMode: RecordingV3CertificationMode,
): RecordingV3Mode {
  return certificationMode === "local" ? "strict_local" : "strict_certified";
}

export function recordingV3CertificationModeForMode(
  recordingMode: RecordingV3Mode,
): RecordingV3CertificationMode {
  return recordingMode === "strict_local" ? "local" : "certified";
}

export function normalizeRecordingV3Provenance(
  deliveryPolicy: unknown,
  recordingMode: unknown,
): Pick<RecordingResultV3Base, "delivery_policy" | "recording_mode"> | null {
  if (deliveryPolicy === "strict") {
    if (recordingMode === undefined || recordingMode === "certified") {
      return { delivery_policy: "strict", recording_mode: "strict_certified" };
    }
    if (recordingMode === "strict_local" || recordingMode === "strict_certified") {
      return { delivery_policy: "strict", recording_mode: recordingMode };
    }
  }
  if (deliveryPolicy === "development" && recordingMode === "uncertified_development") {
    return { delivery_policy: "strict", recording_mode: "strict_local" };
  }
  return null;
}

export function normalizeRecordingV3Mode(recordingMode: unknown): RecordingV3Mode | null {
  if (recordingMode === "strict_local" || recordingMode === "uncertified_development") {
    return "strict_local";
  }
  if (recordingMode === "strict_certified" || recordingMode === "certified") {
    return "strict_certified";
  }
  return null;
}

function isValidArtifactQualification(
  status: "completed" | "quality_failed",
  recordingMode: RecordingV3Mode,
  certificationProfile: unknown,
): boolean {
  if (recordingMode === "strict_certified") {
    return status === "quality_failed" || isProfileReference(certificationProfile);
  }
  return recordingMode === "strict_local" && certificationProfile === null;
}

export function readRecordingCertifiedProfileV3(
  value: unknown,
): RecordingCertifiedProfileV3 | null {
  if (!isRecord(value) || !hasExactKeys(value, PROFILE_KEYS)) return null;
  if (value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if (!isNonEmptyString(value.profile_id)) return null;
  if (
    value.stage !== "shadow" &&
    value.stage !== "internal" &&
    value.stage !== "certified" &&
    value.stage !== "disabled"
  ) {
    return null;
  }
  if (
    value.target_class !== "browser" &&
    value.target_class !== "display" &&
    value.target_class !== "window"
  )
    return null;
  if (value.platform !== "darwin" && value.platform !== "win32") return null;
  const strings = [
    value.arch,
    value.hardware_model,
    value.hardware_chip,
    value.os_build,
    value.backend_id,
    value.backend_version,
    value.electron_version,
    value.chromium_version,
    value.ffmpeg_version,
    value.kill_switch_id,
  ];
  if (!strings.every(isNonEmptyString)) return null;
  if (!isPositiveInteger(value.addon_protocol_version)) return null;
  if (
    !isSha256(value.addon_sha256) ||
    !isSha256(value.ffmpeg_sha256) ||
    !isSha256(value.evidence_artifact_sha256)
  )
    return null;
  if (!isPositiveInteger(value.output_width) || !isPositiveInteger(value.output_height))
    return null;
  if (!isExactStrictFrameRate(value.exact_fps)) return null;
  if (value.cursor_policy !== RECORDING_CURSOR_POLICY_V3) return null;
  if (!Array.isArray(value.audio_roles) || value.audio_roles.length !== 0) return null;
  if (!isIsoTimestamp(value.valid_from) || !isIsoTimestamp(value.valid_until)) return null;
  if (Date.parse(value.valid_from) >= Date.parse(value.valid_until)) return null;
  return value as unknown as RecordingCertifiedProfileV3;
}

export function readSignedRecordingCertificationManifestV3(
  value: unknown,
): SignedRecordingCertificationManifestV3 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["payload", "signature"])) return null;
  if (!isRecord(value.payload) || !hasExactKeys(value.payload, MANIFEST_PAYLOAD_KEYS)) return null;
  const payload = value.payload;
  if (
    payload.schema_version !== RECORDING_CERTIFICATION_MANIFEST_SCHEMA_VERSION_V3 ||
    payload.canonicalization !== RECORDING_CERTIFICATION_CANONICALIZATION_V3 ||
    payload.signature_algorithm !== RECORDING_CERTIFICATION_SIGNATURE_ALGORITHM_V3
  ) {
    return null;
  }
  if (!isNonEmptyString(payload.manifest_id) || !isNonEmptyString(payload.signer_key_id))
    return null;
  if (
    !isIsoTimestamp(payload.issued_at) ||
    !isIsoTimestamp(payload.valid_from) ||
    !isIsoTimestamp(payload.valid_until)
  )
    return null;
  const validFrom = Date.parse(payload.valid_from);
  const validUntil = Date.parse(payload.valid_until);
  if (validFrom >= validUntil || Date.parse(payload.issued_at) > validUntil) return null;
  if (
    !Array.isArray(payload.disabled_kill_switch_ids) ||
    !payload.disabled_kill_switch_ids.every(isNonEmptyString)
  )
    return null;
  if (new Set(payload.disabled_kill_switch_ids).size !== payload.disabled_kill_switch_ids.length)
    return null;
  if (!Array.isArray(payload.profiles)) return null;
  const profiles = payload.profiles.map(readRecordingCertifiedProfileV3);
  if (profiles.some((profile) => profile === null)) return null;
  const typedProfiles = profiles as RecordingCertifiedProfileV3[];
  if (new Set(typedProfiles.map((profile) => profile.profile_id)).size !== typedProfiles.length)
    return null;
  if (
    typedProfiles.some(
      (profile) =>
        Date.parse(profile.valid_from) < validFrom || Date.parse(profile.valid_until) > validUntil,
    )
  ) {
    return null;
  }
  if (!isBase64Signature(value.signature)) return null;
  return value as unknown as SignedRecordingCertificationManifestV3;
}

export function recordingCertificationManifestValidAt(
  manifest: SignedRecordingCertificationManifestV3,
  nowMs: number,
): boolean {
  return (
    nowMs >= Date.parse(manifest.payload.valid_from) &&
    nowMs < Date.parse(manifest.payload.valid_until)
  );
}

export function recordingCertifiedProfileEnabledAt(
  manifest: SignedRecordingCertificationManifestV3,
  profile: RecordingCertifiedProfileV3,
  nowMs: number,
): boolean {
  return (
    recordingCertificationManifestValidAt(manifest, nowMs) &&
    profile.stage === "certified" &&
    nowMs >= Date.parse(profile.valid_from) &&
    nowMs < Date.parse(profile.valid_until) &&
    !manifest.payload.disabled_kill_switch_ids.includes(profile.kill_switch_id)
  );
}

function isSourceRateProbe(value: unknown): value is RecordingSourceRateProbeV2 {
  return (
    isRecord(value) &&
    (value.measured_fps === null || isRational(value.measured_fps)) &&
    isNonNegativeInteger(value.source_presentations) &&
    isNonNegativeInteger(value.sequence_gaps) &&
    isNonNegativeInteger(value.stale_reuses) &&
    isFiniteNonNegative(value.probe_duration_ms)
  );
}

function isStorageEstimate(value: unknown): value is RecordingStorageEstimateV2 {
  return (
    isRecord(value) &&
    isFiniteNonNegative(value.estimated_bytes_per_second) &&
    isFiniteNonNegative(value.required_bytes_for_ten_minutes) &&
    isFiniteNonNegative(value.available_bytes) &&
    isFiniteNonNegative(value.reserve_bytes)
  );
}

export function readRecordingPreflightV3Request(
  value: unknown,
): RecordingPreflightV3Request | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if ("intent" in value || value.enforcement_mode !== "strict") return null;
  if (value.certification_mode !== "local" && value.certification_mode !== "certified") return null;
  if (
    value.target_class !== "browser" &&
    value.target_class !== "display" &&
    value.target_class !== "window"
  )
    return null;
  if (!isExactStrictFrameRate(value.requested_fps) || !isDimensions(value.dimensions)) return null;
  if (!validateRecordingV3Dimensions(value.certification_mode, value.dimensions).valid) return null;
  if (value.cursor_policy !== RECORDING_CURSOR_POLICY_V3) return null;
  if (
    !Array.isArray(value.audio_roles) ||
    !value.audio_roles.every((role) => role === "microphone" || role === "system") ||
    new Set(value.audio_roles).size !== value.audio_roles.length
  ) {
    return null;
  }
  return value as unknown as RecordingPreflightV3Request;
}

export function readRecordingPreflightV3Dto(value: unknown): RecordingPreflightV3Dto | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if ("intent" in value || "strict_eligible" in value || "development_eligible" in value)
    return null;
  if (value.enforcement_mode !== "strict") return null;
  if (value.certification_mode !== "local" && value.certification_mode !== "certified") return null;
  if (value.recording_mode !== recordingV3ModeForCertificationMode(value.certification_mode))
    return null;
  if (!isNonEmptyString(value.backend_id) || !isNonEmptyString(value.backend_version)) return null;
  if (!isPositiveInteger(value.addon_protocol_version)) return null;
  if (value.platform !== "darwin" && value.platform !== "win32") return null;
  const strings = [value.arch, value.hardware_model, value.hardware_chip, value.os_build];
  if (!strings.every(isNonEmptyString)) return null;
  if (value.manifest_id !== null && !isNonEmptyString(value.manifest_id)) return null;
  if (value.matched_profile !== null && !readRecordingCertifiedProfileV3(value.matched_profile))
    return null;
  if (!isSourceRateProbe(value.source_rate) || !isStorageEstimate(value.storage)) return null;
  if (
    typeof value.native_probe_passed !== "boolean" ||
    typeof value.permissions_granted !== "boolean" ||
    typeof value.runtime_eligible !== "boolean" ||
    typeof value.certification_eligible !== "boolean" ||
    typeof value.eligible !== "boolean" ||
    !isFailureCodes(value.failure_codes)
  ) {
    return null;
  }
  if (value.runtime_eligible && (!value.native_probe_passed || !value.permissions_granted))
    return null;
  if (!value.runtime_eligible && value.certification_eligible) return null;
  if (
    value.eligible !==
    (value.certification_mode === "local"
      ? value.runtime_eligible
      : value.certification_eligible)
  ) {
    return null;
  }
  if (
    value.certification_mode === "certified" &&
    value.certification_eligible &&
    (value.matched_profile === null ||
      value.manifest_id === null ||
      !value.runtime_eligible ||
      value.failure_codes.length > 0)
  ) {
    return null;
  }
  if (
    value.certification_mode === "local" &&
    (value.matched_profile !== null || value.manifest_id !== null)
  ) {
    return null;
  }
  if (value.eligible && value.failure_codes.length > 0) return null;
  return value as unknown as RecordingPreflightV3Dto;
}

export function readRecordingFrameLedgerEntryV3(
  value: unknown,
): RecordingFrameLedgerEntryV3 | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  const nonNegative = [
    value.source_epoch,
    value.active_segment,
    value.source_frame_count,
    value.source_timestamp_us,
    value.active_time_pts_us,
  ];
  if (!nonNegative.every(isNonNegativeInteger)) return null;
  const positive = [
    value.delivery_ordinal,
    value.native_lease_ordinal,
    value.native_commit_ordinal,
    value.encoded_ordinal,
    value.decoded_ordinal,
  ];
  if (!positive.every(isPositiveInteger) || !isSha256(value.bgra_sha256)) return null;
  if (!positive.every((ordinal) => ordinal === value.delivery_ordinal)) return null;
  return value as unknown as RecordingFrameLedgerEntryV3;
}

export function readRecordingFrameLedgerV3(value: unknown): RecordingFrameLedgerEntryV3[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries = value.map(readRecordingFrameLedgerEntryV3);
  if (entries.some((entry) => entry === null)) return null;
  const typedEntries = entries as RecordingFrameLedgerEntryV3[];
  for (let index = 0; index < typedEntries.length; index += 1) {
    const entry = typedEntries[index];
    if (entry.delivery_ordinal !== index + 1) return null;
    if (index === 0) continue;
    const previous = typedEntries[index - 1];
    if (
      entry.source_epoch < previous.source_epoch ||
      entry.active_segment < previous.active_segment
    )
      return null;
    if (
      entry.source_epoch > previous.source_epoch + 1 ||
      entry.active_segment > previous.active_segment + 1
    )
      return null;
    if (entry.active_time_pts_us <= previous.active_time_pts_us) return null;
    if (entry.source_epoch === previous.source_epoch) {
      if (entry.source_timestamp_us <= previous.source_timestamp_us) return null;
      if (
        entry.active_segment === previous.active_segment &&
        entry.source_frame_count !== previous.source_frame_count + 1
      ) {
        return null;
      }
      if (
        entry.active_segment !== previous.active_segment &&
        entry.source_frame_count <= previous.source_frame_count
      ) {
        return null;
      }
    } else if (entry.active_segment === previous.active_segment) {
      return null;
    }
  }
  return typedEntries;
}

export function readRecordingDiagnosticFrameLedgerEntryV3(
  value: unknown,
): RecordingDiagnosticFrameLedgerEntryV3 | null {
  if (!isRecord(value) || value.decoded_ordinal !== null) return null;
  if (!isFailureCodes(value.failure_codes) || value.failure_codes.length === 0) return null;
  const completedShape = { ...value, decoded_ordinal: value.delivery_ordinal };
  if (!readRecordingFrameLedgerEntryV3(completedShape)) return null;
  return value as unknown as RecordingDiagnosticFrameLedgerEntryV3;
}

export function readRecordingDiagnosticFrameLedgerV3(
  value: unknown,
): RecordingDiagnosticFrameLedgerEntryV3[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const entries = value.map(readRecordingDiagnosticFrameLedgerEntryV3);
  if (entries.some((entry) => entry === null)) return null;
  const typedEntries = entries as RecordingDiagnosticFrameLedgerEntryV3[];
  const completedShape = typedEntries.map((entry) => ({
    ...entry,
    decoded_ordinal: entry.delivery_ordinal,
  }));
  return readRecordingFrameLedgerV3(completedShape) ? typedEntries : null;
}

export function readRecordingCadenceEvidenceV3(value: unknown): RecordingCadenceEvidenceV3 | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if (
    value.guarantee_boundary !== RECORDING_GUARANTEE_BOUNDARY_V3 ||
    value.source_ordinal_kind !== RECORDING_SOURCE_ORDINAL_KIND_V3
  )
    return null;
  if (!isExactStrictFrameRate(value.requested_fps)) return null;
  if (value.source_fps !== null && !isRational(value.source_fps)) return null;
  if (value.stream_time_base !== null && !isRational(value.stream_time_base)) return null;
  const counts = [
    value.active_duration_us,
    value.expected_slots,
    value.source_presentations,
    value.delivery_frames,
    value.native_commits,
    value.encoded_frames,
    value.artifact_decoded_frames,
    value.source_ordinal_gaps,
    value.source_timestamp_regressions,
    value.delivery_duplicates,
    value.native_lease_overflows,
    value.native_backpressure_events,
    value.native_deadline_misses,
    value.artifact_pts_gaps,
    value.artifact_pts_duplicates,
  ];
  if (!counts.every(isNonNegativeInteger)) return null;
  if (
    typeof value.full_decode_succeeded !== "boolean" ||
    !isQualityVerdict(value.verdict) ||
    !isFailureCodes(value.failure_codes)
  )
    return null;
  if (value.verdict === "passed") {
    const frameCounts = [
      value.source_presentations,
      value.delivery_frames,
      value.native_commits,
      value.encoded_frames,
      value.artifact_decoded_frames,
    ];
    if (!frameCounts.every((count) => count === value.expected_slots)) return null;
    const anomalies = counts.slice(7);
    if (
      !anomalies.every((count) => count === 0) ||
      !value.full_decode_succeeded ||
      value.failure_codes.length > 0
    )
      return null;
  }
  return value as unknown as RecordingCadenceEvidenceV3;
}

export function readRecordingQualityEvidenceV3(value: unknown): RecordingQualityEvidenceV3 | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if (
    value.measurement_scope !== "runtime_integrity" &&
    value.measurement_scope !== "certification_fixture"
  )
    return null;
  if (!isNonNegativeInteger(value.evaluated_frames)) return null;
  const metricKeys = [
    "full_frame_luma_ssim",
    "text_edge_roi_ssim",
    "p01_edge_contrast_retention",
    "edge_spread_increase_px",
    "overlay_geometry_delta_px",
    "color_channel_delta",
  ] as const;
  if (metricKeys.some((key) => value[key] !== null && !isMetric(value[key]))) return null;
  if (
    value.lossless_master_hashes_match !== null &&
    typeof value.lossless_master_hashes_match !== "boolean"
  )
    return null;
  if (
    value.certification_verdict !== null &&
    value.certification_verdict !== "passed" &&
    value.certification_verdict !== "failed"
  )
    return null;
  if (!isQualityVerdict(value.verdict) || !isFailureCodes(value.failure_codes)) return null;
  if (value.measurement_scope === "runtime_integrity") {
    if (value.reference_identity !== null || value.certification_verdict !== null) return null;
    if (metricKeys.some((key) => value[key] !== null)) return null;
  } else {
    if (!isRecord(value.reference_identity)) return null;
    if (
      !isNonEmptyString(value.reference_identity.fixture_id) ||
      !isNonEmptyString(value.reference_identity.fixture_version) ||
      !isSha256(value.reference_identity.reference_sha256)
    ) {
      return null;
    }
  }
  return value as unknown as RecordingQualityEvidenceV3;
}

export function readRecordingCaptureContractV3(value: unknown): RecordingCaptureContractV3 | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if (
    value.guarantee_boundary !== RECORDING_GUARANTEE_BOUNDARY_V3 ||
    value.source_ordinal_kind !== RECORDING_SOURCE_ORDINAL_KIND_V3
  )
    return null;
  if (
    value.target_class !== "browser" &&
    value.target_class !== "display" &&
    value.target_class !== "window"
  )
    return null;
  if (!isExactStrictFrameRate(value.exact_fps) || !isDimensions(value.dimensions)) return null;
  if (value.cursor_policy !== RECORDING_CURSOR_POLICY_V3) return null;
  if (!Array.isArray(value.audio_roles) || value.audio_roles.length !== 0) return null;
  return value as unknown as RecordingCaptureContractV3;
}

export function readRecordingBundleV3(value: unknown): RecordingBundleV3 | null {
  if (!isRecord(value) || value.schema_version !== RECORDING_BUNDLE_SCHEMA_VERSION_V3) return null;
  if (value.status !== "completed" && value.status !== "quality_failed") return null;
  if (!isIsoTimestamp(value.created_at)) return null;
  const provenance = normalizeRecordingV3Provenance(value.delivery_policy, value.recording_mode);
  if (!provenance) return null;
  const captureContract = readRecordingCaptureContractV3(value.capture_contract);
  if (!captureContract) return null;
  if (
    !validateRecordingV3Dimensions(
      recordingV3CertificationModeForMode(provenance.recording_mode),
      captureContract.dimensions,
    ).valid
  ) {
    return null;
  }
  if (value.certification_profile !== null && !isProfileReference(value.certification_profile))
    return null;
  if (
    !isValidArtifactQualification(
      value.status,
      provenance.recording_mode,
      value.certification_profile,
    )
  ) {
    return null;
  }
  if (!isRecord(value.master) || !isBundleArtifact(value.master, "master/video.mkv")) return null;
  if (value.master.codec !== "ffv1" || value.master.pixel_format !== "bgra") return null;
  if (
    !isPositiveInteger(value.master.frame_count) ||
    !isExactStrictFrameRate(value.master.exact_fps)
  )
    return null;
  if (
    value.proxy !== null &&
    (!isRecord(value.proxy) ||
      !isBundleArtifact(value.proxy, "proxy/video.mp4") ||
      value.proxy.codec !== "h264")
  ) {
    return null;
  }
  if (value.status === "completed" && value.proxy === null) return null;
  if (!Array.isArray(value.audio) || value.audio.length !== 0) return null;
  if (!isRecord(value.evidence) || !isRecord(value.sidecars)) return null;
  if (
    value.evidence.cadence_path !== "evidence/cadence.json" ||
    value.evidence.runtime_quality_path !== "evidence/runtime-quality.json" ||
    (value.evidence.certification_quality_path !== null &&
      value.evidence.certification_quality_path !== "evidence/certification-quality.json")
  ) {
    return null;
  }
  if (
    (value.sidecars.actions_path !== null &&
      value.sidecars.actions_path !== "sidecars/actions.json") ||
    (value.sidecars.cursor_path !== null && value.sidecars.cursor_path !== "sidecars/cursor.json")
  ) {
    return null;
  }
  if (value.frame_ledger_path !== "evidence/frame-ledger.jsonl") return null;
  if (value.diagnostics_manifest_path !== "diagnostics/manifest.json") return null;
  if (!isFailureCodes(value.failure_codes)) return null;
  return { ...value, ...provenance } as unknown as RecordingBundleV3;
}

export function readExportRecordingSourceV3(value: unknown): ExportRecordingSourceV3 | null {
  if (!isRecord(value) || value.version !== RECORDING_COMPOSITION_SOURCE_VERSION_V3) return null;
  const strings = [
    value.bundle_path,
    value.master_path,
    value.proxy_path,
    value.cadence_evidence_path,
    value.quality_evidence_path,
    value.frame_ledger_path,
  ];
  if (!strings.every(isNonEmptyString)) return null;
  const recordingMode =
    value.recording_mode === undefined
      ? "strict_certified"
      : normalizeRecordingV3Mode(value.recording_mode);
  if (!recordingMode) return null;
  if (
    (recordingMode === "strict_certified" &&
      !isNonEmptyString(value.certification_profile_id)) ||
    (recordingMode === "strict_local" && value.certification_profile_id !== null)
  ) {
    return null;
  }
  if (
    !isExactStrictFrameRate(value.exact_source_fps) ||
    !isPositiveInteger(value.source_frame_count)
  )
    return null;
  if (!isPositiveInteger(value.master_width) || !isPositiveInteger(value.master_height))
    return null;
  if (value.quality_verdict !== "passed" && value.quality_verdict !== "degraded") return null;
  if (
    value.guarantee_boundary !== RECORDING_GUARANTEE_BOUNDARY_V3 ||
    value.source_scope_verified !== true
  )
    return null;
  return { ...value, recording_mode: recordingMode } as unknown as ExportRecordingSourceV3;
}

export function readRecordingInfoV3(value: unknown): RecordingInfoV3 | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if (!isNonEmptyString(value.path) || !isFiniteNonNegative(value.captured_at)) return null;
  if (
    value.guarantee_boundary !== RECORDING_GUARANTEE_BOUNDARY_V3 ||
    value.source_scope_verified !== true
  )
    return null;
  if (!isQualityVerdict(value.quality_verdict)) return null;
  if (value.certification_profile !== null && !isProfileReference(value.certification_profile))
    return null;
  const recordingMode =
    value.recording_mode === undefined
      ? "strict_certified"
      : normalizeRecordingV3Mode(value.recording_mode);
  if (!recordingMode) return null;
  if (
    (recordingMode === "strict_certified" &&
      !isProfileReference(value.certification_profile)) ||
    (recordingMode === "strict_local" && value.certification_profile !== null)
  ) {
    return null;
  }
  const nullableStrings = [
    value.master_path,
    value.proxy_path,
    value.cadence_evidence_path,
    value.quality_evidence_path,
    value.frame_ledger_path,
    value.actions_path,
    value.cursor_path,
    value.bundle_path,
  ];
  if (!nullableStrings.every((field) => field === null || isNonEmptyString(field))) return null;
  if (value.duration_ms !== null && !isFiniteNonNegative(value.duration_ms)) return null;
  if (value.width !== null && !isPositiveInteger(value.width)) return null;
  if (value.height !== null && !isPositiveInteger(value.height)) return null;
  if (value.exact_source_fps !== null && !isRational(value.exact_source_fps)) return null;
  if (value.source_frame_count !== null && !isNonNegativeInteger(value.source_frame_count))
    return null;
  return { ...value, recording_mode: recordingMode } as unknown as RecordingInfoV3;
}

export function readRecordingResultV3(value: unknown): RecordingResultV3 | null {
  if (!isRecord(value) || value.version !== RECORDING_CONTRACT_VERSION_V3) return null;
  if (value.status !== "completed" && value.status !== "quality_failed") return null;
  if (value.guarantee_boundary !== RECORDING_GUARANTEE_BOUNDARY_V3) return null;
  const provenance = normalizeRecordingV3Provenance(value.delivery_policy, value.recording_mode);
  if (!provenance) return null;
  if (
    !isNonEmptyString(value.bundle_path) ||
    !isFiniteNonNegative(value.duration_ms) ||
    !isFiniteNonNegative(value.bytes) ||
    !isPositiveInteger(value.output_width) ||
    !isPositiveInteger(value.output_height)
  )
    return null;
  if (value.master_path !== null && !isNonEmptyString(value.master_path)) return null;
  if (value.proxy_path !== null && !isNonEmptyString(value.proxy_path)) return null;
  if (
    !readRecordingCadenceEvidenceV3(value.cadence_evidence) ||
    !readRecordingQualityEvidenceV3(value.quality_evidence)
  )
    return null;
  if (value.certification_profile !== null && !isProfileReference(value.certification_profile))
    return null;
  if (
    !isValidArtifactQualification(
      value.status,
      provenance.recording_mode,
      value.certification_profile,
    )
  ) {
    return null;
  }
  if (value.status === "completed") {
    if (!isNonEmptyString(value.output_path)) return null;
    if (value.diagnostic_bundle_path !== null) return null;
  } else {
    if (value.output_path !== null || !isNonEmptyString(value.diagnostic_bundle_path)) return null;
  }
  return { ...value, ...provenance } as unknown as RecordingResultV3;
}

export function readRecordingEventV3(value: unknown): RecordingEventV3 | null {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return null;
  if (value.type === "preflight") {
    const result = readRecordingPreflightV3Dto(value.result);
    return result ? { type: "preflight", result } : null;
  }
  if (value.type === "readiness") {
    if (
      value.state !== "source_ready" &&
      value.state !== "first_frame_committed" &&
      value.state !== "pre_input_frame_committed"
    ) {
      return null;
    }
    return value as unknown as RecordingEventV3;
  }
  if (value.type === "live-evidence") {
    const evidence = readRecordingCadenceEvidenceV3(value.evidence);
    return evidence ? { type: "live-evidence", evidence } : null;
  }
  if (value.type === "verifying") {
    return typeof value.progress === "number" &&
      Number.isFinite(value.progress) &&
      value.progress >= 0 &&
      value.progress <= 1
      ? (value as unknown as RecordingEventV3)
      : null;
  }
  if (value.type === "completed" || value.type === "quality-failed") {
    const result = readRecordingResultV3(value.result);
    return result?.status === (value.type === "completed" ? "completed" : "quality_failed")
      ? (value as unknown as RecordingEventV3)
      : null;
  }
  if (value.type === "failed") {
    return isNonEmptyString(value.message) && isFailureCodes(value.failure_codes)
      ? (value as unknown as RecordingEventV3)
      : null;
  }
  if (value.type === "heartbeat") {
    return isNonNegativeInteger(value.seq) ? (value as unknown as RecordingEventV3) : null;
  }
  return null;
}

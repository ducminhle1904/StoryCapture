import type {
  CaptureBackendV2Capabilities,
  RecordingCertifiedTier,
  RecordingPlatform,
  RecordingTargetClass,
} from "@storycapture/shared-types/recording-v2";

/**
 * Release engineering adds entries only after the packaged certification
 * matrix passes. An empty catalogue keeps Strict fail-closed on unqualified
 * hardware while Standard remains available.
 */
export const BUNDLED_RECORDING_CERTIFICATION_TIERS: readonly RecordingCertifiedTier[] = [];

export interface RecordingCertificationLookup {
  platform: RecordingPlatform;
  arch: string;
  hardwareFingerprint: string;
  targetClass: RecordingTargetClass;
  capabilities: CaptureBackendV2Capabilities;
  outputWidth: number;
  outputHeight: number;
}

export function disabledRecordingCertificationTierIds(
  value = process.env.STORYCAPTURE_DISABLE_RECORDING_TIER_IDS ?? "",
): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function findRecordingCertificationTier(
  lookup: RecordingCertificationLookup,
  catalogue: readonly RecordingCertifiedTier[] = BUNDLED_RECORDING_CERTIFICATION_TIERS,
  disabledTierIds = disabledRecordingCertificationTierIds(),
): RecordingCertifiedTier | null {
  return (
    catalogue.find((tier) => recordingCertificationTierMatches(tier, lookup, disabledTierIds)) ??
    null
  );
}

export function recordingCertificationTierMatches(
  tier: RecordingCertifiedTier | null | undefined,
  lookup: RecordingCertificationLookup,
  disabledTierIds = disabledRecordingCertificationTierIds(),
): tier is RecordingCertifiedTier {
  return Boolean(
    tier &&
      tier.version === 2 &&
      !disabledTierIds.has(tier.id) &&
      tier.stage === "certified" &&
      tier.platform === lookup.platform &&
      tier.arch === lookup.arch &&
      tier.hardware_fingerprint === lookup.hardwareFingerprint &&
      tier.target_class === lookup.targetClass &&
      tier.backend_id === lookup.capabilities.backend_id &&
      tier.backend_version === lookup.capabilities.backend_version &&
      tier.exact_fps.numerator === 60 &&
      tier.exact_fps.denominator === 1 &&
      tier.output_width === lookup.outputWidth &&
      tier.output_height === lookup.outputHeight,
  );
}

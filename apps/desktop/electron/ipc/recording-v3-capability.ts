import type {
  RecordingCertifiedProfileV3,
  RecordingFailureCodeV3,
  RecordingPlatform,
  RecordingPreflightV3Dto,
  RecordingPreflightV3Request,
  RecordingSourceRateProbeV2,
  RecordingStorageEstimateV2,
} from "@storycapture/shared-types/recording-v2";
import {
  RECORDING_V3_BROWSER_BACKEND_ID,
  RECORDING_V3_BROWSER_BACKEND_VERSION,
} from "./recording-v3-browser-backend";

export interface RecordingV3CapabilityFacts {
  platform: RecordingPlatform;
  arch: string;
  hardwareModel: string;
  hardwareChip: string;
  osBuild: string;
  addonProtocolVersion: number;
  manifestId: string | null;
  matchedProfile: RecordingCertifiedProfileV3 | null;
  sourceRate: RecordingSourceRateProbeV2;
  storage: RecordingStorageEstimateV2;
  storageEligible: boolean;
  nativeProbePassed: boolean;
  permissionsGranted: boolean;
  failureCodes?: readonly RecordingFailureCodeV3[];
}

function exactDimensions(request: RecordingPreflightV3Request): boolean {
  const dimensions = request.dimensions;
  return (
    dimensions.logical_width === 960 &&
    dimensions.logical_height === 540 &&
    dimensions.capture_dpr === 2 &&
    dimensions.physical_width === 1920 &&
    dimensions.physical_height === 1080 &&
    dimensions.requested_output_width === 1920 &&
    dimensions.requested_output_height === 1080
  );
}

export function evaluateRecordingV3Capability(
  request: RecordingPreflightV3Request,
  facts: RecordingV3CapabilityFacts,
): RecordingPreflightV3Dto {
  const failureCodes = [...new Set(facts.failureCodes ?? [])];
  const fail = (code: RecordingFailureCodeV3) => {
    if (!failureCodes.includes(code)) failureCodes.push(code);
  };

  if (request.target_class !== "browser") fail("target_unsupported");
  if (request.audio_roles.length > 0) fail("unsupported_audio_role");
  if (
    request.requested_fps.numerator !== 60 ||
    request.requested_fps.denominator !== 1 ||
    request.cursor_policy !== "sidecar_reconstructed" ||
    !exactDimensions(request)
  ) {
    fail("contract_mismatch");
  }
  if (
    !facts.nativeProbePassed &&
    !failureCodes.some((code) =>
      ["addon_load_failed", "addon_protocol_mismatch", "addon_hash_mismatch"].includes(code),
    )
  ) {
    fail("addon_load_failed");
  }
  if (!facts.permissionsGranted) fail("permission_denied");
  if (!facts.storageEligible) fail("storage_preflight_failed");
  if (
    facts.sourceRate.measured_fps?.numerator !== 60 ||
    facts.sourceRate.measured_fps.denominator !== 1 ||
    facts.sourceRate.sequence_gaps > 0 ||
    facts.sourceRate.stale_reuses > 0
  ) {
    fail("runtime_integrity_failed");
  }
  if (
    request.intent === "strict" &&
    !facts.matchedProfile &&
    !failureCodes.some((code) => code.startsWith("manifest_"))
  ) {
    fail("profile_mismatch");
  }
  if (request.intent === "development" && (facts.manifestId !== null || facts.matchedProfile)) {
    fail("contract_mismatch");
  }

  const commonEligible = failureCodes.length === 0;

  return {
    version: 3,
    intent: request.intent,
    recording_mode: request.intent === "strict" ? "certified" : "uncertified_development",
    backend_id: RECORDING_V3_BROWSER_BACKEND_ID,
    backend_version: RECORDING_V3_BROWSER_BACKEND_VERSION,
    addon_protocol_version: facts.addonProtocolVersion,
    platform: facts.platform,
    arch: facts.arch,
    hardware_model: facts.hardwareModel,
    hardware_chip: facts.hardwareChip,
    os_build: facts.osBuild,
    manifest_id: facts.manifestId,
    matched_profile: facts.matchedProfile,
    source_rate: facts.sourceRate,
    storage: facts.storage,
    native_probe_passed: facts.nativeProbePassed,
    permissions_granted: facts.permissionsGranted,
    strict_eligible:
      request.intent === "strict" && commonEligible && facts.matchedProfile !== null,
    development_eligible: request.intent === "development" && commonEligible,
    failure_codes: failureCodes,
  };
}

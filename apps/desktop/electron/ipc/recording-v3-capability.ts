import type {
  RecordingPlatform,
  RecordingSourceRateProbeV2,
  RecordingStorageEstimateV2,
} from "@storycapture/shared-types/recording-v2";
import type {
  RecordingCertifiedProfileV3,
  RecordingFailureCodeV3,
  RecordingPreflightV3Dto,
  RecordingPreflightV3Request,
  RecordingV3Qualification,
} from "@storycapture/shared-types/recording-v3";
import {
  recordingV3ModeForCertificationMode,
  validateRecordingV3Dimensions,
} from "@storycapture/shared-types/recording-v3";
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
  runtimeFailureCodes?: readonly RecordingFailureCodeV3[];
  certificationFailureCodes?: readonly RecordingFailureCodeV3[];
}

export function recordingV3QualificationFromPreflight(
  preflight: RecordingPreflightV3Dto,
): RecordingV3Qualification | null {
  if (!preflight.eligible) return null;
  if (preflight.recording_mode === "strict_local") {
    return preflight.manifest_id === null && preflight.matched_profile === null
      ? { mode: "strict_local" }
      : null;
  }
  return preflight.manifest_id && preflight.matched_profile
    ? {
        mode: "strict_certified",
        manifestId: preflight.manifest_id,
        profile: preflight.matched_profile,
      }
    : null;
}

export function evaluateRecordingV3Capability(
  request: RecordingPreflightV3Request,
  facts: RecordingV3CapabilityFacts,
): RecordingPreflightV3Dto {
  const runtimeFailureCodes = [...new Set(facts.runtimeFailureCodes ?? [])];
  const certificationFailureCodes = [...new Set(facts.certificationFailureCodes ?? [])];
  const fail = (code: RecordingFailureCodeV3) => {
    if (!runtimeFailureCodes.includes(code)) runtimeFailureCodes.push(code);
  };

  if (request.target_class !== "browser") fail("target_unsupported");
  if (request.audio_roles.length > 0) fail("unsupported_audio_role");
  if (
    request.requested_fps.numerator !== 60 ||
    request.requested_fps.denominator !== 1 ||
    request.cursor_policy !== "sidecar_reconstructed" ||
    !validateRecordingV3Dimensions(request.certification_mode, request.dimensions).valid
  ) {
    fail("contract_mismatch");
  }
  if (
    !facts.nativeProbePassed &&
    !runtimeFailureCodes.some((code) =>
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
    (!facts.manifestId || !facts.matchedProfile) &&
    !certificationFailureCodes.some((code) => code.startsWith("manifest_")) &&
    !certificationFailureCodes.includes("profile_mismatch")
  ) {
    certificationFailureCodes.push("profile_mismatch");
  }

  const runtimeEligible = runtimeFailureCodes.length === 0;
  const certificationEligible =
    runtimeEligible &&
    certificationFailureCodes.length === 0 &&
    facts.manifestId !== null &&
    facts.matchedProfile !== null;
  const eligible =
    request.certification_mode === "local" ? runtimeEligible : certificationEligible;
  const failureCodes =
    request.certification_mode === "local"
      ? runtimeFailureCodes
      : [...new Set([...runtimeFailureCodes, ...certificationFailureCodes])];
  const attachCertification = request.certification_mode === "certified";

  return {
    version: 3,
    enforcement_mode: request.enforcement_mode,
    certification_mode: request.certification_mode,
    recording_mode: recordingV3ModeForCertificationMode(request.certification_mode),
    backend_id: RECORDING_V3_BROWSER_BACKEND_ID,
    backend_version: RECORDING_V3_BROWSER_BACKEND_VERSION,
    addon_protocol_version: facts.addonProtocolVersion,
    platform: facts.platform,
    arch: facts.arch,
    hardware_model: facts.hardwareModel,
    hardware_chip: facts.hardwareChip,
    os_build: facts.osBuild,
    manifest_id: attachCertification ? facts.manifestId : null,
    matched_profile: attachCertification ? facts.matchedProfile : null,
    source_rate: facts.sourceRate,
    storage: facts.storage,
    native_probe_passed: facts.nativeProbePassed,
    permissions_granted: facts.permissionsGranted,
    runtime_eligible: runtimeEligible,
    certification_eligible: certificationEligible,
    eligible,
    failure_codes: failureCodes,
  };
}

import { createPublicKey, KeyObject, type PublicKeyInput, verify } from "node:crypto";

import {
  type RecordingCertifiedProfileV3,
  type RecordingFailureCodeV3,
  readSignedRecordingCertificationManifestV3,
  recordingCertificationManifestValidAt,
  recordingCertifiedProfileEnabledAt,
  type SignedRecordingCertificationManifestV3,
} from "@storycapture/shared-types/recording-v2";

import { canonicalizeRecordingCertificationJson } from "./recording-v3-certification-canonical-json";
import { GENERATED_RECORDING_CERTIFICATION_SIGNER_KEYS_V3 } from "./recording-v3-certification-signer-keys.generated";

export type RecordingCertificationPublicKeyV3 = KeyObject | PublicKeyInput;
export type RecordingCertificationSignerKeyMapV3 = Readonly<
  Record<string, RecordingCertificationPublicKeyV3>
>;

/** Populated only by a signed release build after protected certification. */
export const BUNDLED_RECORDING_CERTIFICATION_SIGNER_KEYS_V3: RecordingCertificationSignerKeyMapV3 =
  GENERATED_RECORDING_CERTIFICATION_SIGNER_KEYS_V3;

export interface RecordingCertificationRuntimeIdentityV3 {
  target_class: RecordingCertifiedProfileV3["target_class"];
  platform: RecordingCertifiedProfileV3["platform"];
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
  exact_fps: RecordingCertifiedProfileV3["exact_fps"];
  cursor_policy: RecordingCertifiedProfileV3["cursor_policy"];
  audio_roles: [];
  evidence_artifact_sha256: string;
}

export interface RecordingCertificationManifestVerificationV3 {
  manifest: SignedRecordingCertificationManifestV3 | null;
  failure_codes: RecordingFailureCodeV3[];
}

export interface RecordingCertificationProfileResolutionV3
  extends RecordingCertificationManifestVerificationV3 {
  profile: RecordingCertifiedProfileV3 | null;
}

function asPublicKey(value: RecordingCertificationPublicKeyV3): KeyObject {
  return value instanceof KeyObject ? value : createPublicKey(value);
}

export function verifyRecordingCertificationManifestV3(
  value: unknown,
  signerKeys: RecordingCertificationSignerKeyMapV3 = BUNDLED_RECORDING_CERTIFICATION_SIGNER_KEYS_V3,
  nowMs = Date.now(),
): RecordingCertificationManifestVerificationV3 {
  const manifest = readSignedRecordingCertificationManifestV3(value);
  if (!manifest) return { manifest: null, failure_codes: ["manifest_signature_invalid"] };
  const signerKey = signerKeys[manifest.payload.signer_key_id];
  if (!signerKey) return { manifest: null, failure_codes: ["manifest_signature_invalid"] };

  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalizeRecordingCertificationJson(manifest.payload)),
      asPublicKey(signerKey),
      Buffer.from(manifest.signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { manifest: null, failure_codes: ["manifest_signature_invalid"] };
  if (nowMs < Date.parse(manifest.payload.valid_from)) {
    return { manifest: null, failure_codes: ["manifest_not_yet_valid"] };
  }
  if (!recordingCertificationManifestValidAt(manifest, nowMs)) {
    return { manifest: null, failure_codes: ["manifest_expired"] };
  }
  return { manifest, failure_codes: [] };
}

export function recordingCertificationProfileMatchesRuntimeV3(
  profile: RecordingCertifiedProfileV3,
  runtime: RecordingCertificationRuntimeIdentityV3,
): boolean {
  return (
    profile.target_class === runtime.target_class &&
    profile.platform === runtime.platform &&
    profile.arch === runtime.arch &&
    profile.hardware_model === runtime.hardware_model &&
    profile.hardware_chip === runtime.hardware_chip &&
    profile.os_build === runtime.os_build &&
    profile.backend_id === runtime.backend_id &&
    profile.backend_version === runtime.backend_version &&
    profile.addon_protocol_version === runtime.addon_protocol_version &&
    profile.addon_sha256 === runtime.addon_sha256 &&
    profile.electron_version === runtime.electron_version &&
    profile.chromium_version === runtime.chromium_version &&
    profile.ffmpeg_version === runtime.ffmpeg_version &&
    profile.ffmpeg_sha256 === runtime.ffmpeg_sha256 &&
    profile.output_width === runtime.output_width &&
    profile.output_height === runtime.output_height &&
    profile.exact_fps.numerator === runtime.exact_fps.numerator &&
    profile.exact_fps.denominator === runtime.exact_fps.denominator &&
    profile.cursor_policy === runtime.cursor_policy &&
    profile.audio_roles.length === runtime.audio_roles.length &&
    profile.evidence_artifact_sha256 === runtime.evidence_artifact_sha256
  );
}

export function resolveRecordingCertificationProfileV3(input: {
  manifest: unknown;
  runtime: RecordingCertificationRuntimeIdentityV3;
  signerKeys?: RecordingCertificationSignerKeyMapV3;
  disabledKillSwitchIds?: ReadonlySet<string>;
  nowMs?: number;
}): RecordingCertificationProfileResolutionV3 {
  const nowMs = input.nowMs ?? Date.now();
  const verification = verifyRecordingCertificationManifestV3(
    input.manifest,
    input.signerKeys,
    nowMs,
  );
  if (!verification.manifest) return { ...verification, profile: null };

  const exactProfiles = verification.manifest.payload.profiles.filter((profile) =>
    recordingCertificationProfileMatchesRuntimeV3(profile, input.runtime),
  );
  if (exactProfiles.length !== 1) {
    return { manifest: verification.manifest, profile: null, failure_codes: ["profile_mismatch"] };
  }
  const profile = exactProfiles[0];
  if (nowMs < Date.parse(profile.valid_from)) {
    return {
      manifest: verification.manifest,
      profile: null,
      failure_codes: ["manifest_not_yet_valid"],
    };
  }
  if (nowMs >= Date.parse(profile.valid_until)) {
    return { manifest: verification.manifest, profile: null, failure_codes: ["profile_expired"] };
  }
  if (
    verification.manifest.payload.disabled_kill_switch_ids.includes(profile.kill_switch_id) ||
    input.disabledKillSwitchIds?.has(profile.kill_switch_id)
  ) {
    return {
      manifest: verification.manifest,
      profile: null,
      failure_codes: ["tier_kill_switch_disabled"],
    };
  }
  if (!recordingCertifiedProfileEnabledAt(verification.manifest, profile, nowMs)) {
    return { manifest: verification.manifest, profile: null, failure_codes: ["profile_mismatch"] };
  }
  return { manifest: verification.manifest, profile, failure_codes: [] };
}

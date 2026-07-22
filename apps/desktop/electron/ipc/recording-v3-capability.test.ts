import type {
  RecordingCertifiedProfileV3,
  RecordingFailureCodeV3,
  RecordingPreflightV3Request,
} from "@storycapture/shared-types/recording-v3";
import { recordingV3DimensionsForViewport } from "@storycapture/shared-types/recording-v3";
import { describe, expect, it } from "vitest";
import {
  evaluateRecordingV3Capability,
  recordingV3QualificationFromPreflight,
  type RecordingV3CapabilityFacts,
} from "./recording-v3-capability";

const sha = "a".repeat(64);
const request: RecordingPreflightV3Request = {
  version: 3,
  enforcement_mode: "strict",
  certification_mode: "certified",
  target_class: "browser",
  requested_fps: { numerator: 60, denominator: 1 },
  dimensions: {
    logical_width: 960,
    logical_height: 540,
    capture_dpr: 2,
    physical_width: 1920,
    physical_height: 1080,
    requested_output_width: 1920,
    requested_output_height: 1080,
  },
  cursor_policy: "sidecar_reconstructed",
  audio_roles: [],
};
const profile: RecordingCertifiedProfileV3 = {
  version: 3,
  profile_id: "profile",
  stage: "certified",
  target_class: "browser",
  platform: "darwin",
  arch: "arm64",
  hardware_model: "Mac17,2",
  hardware_chip: "Apple M5",
  os_build: "25F84",
  backend_id: "electron_offscreen_shared_texture_v3",
  backend_version: "3.0.0",
  addon_protocol_version: 3,
  addon_sha256: sha,
  electron_version: "42.4.1",
  chromium_version: "148.0.7778.265",
  ffmpeg_version: "7.1",
  ffmpeg_sha256: sha,
  output_width: 1920,
  output_height: 1080,
  exact_fps: { numerator: 60, denominator: 1 },
  cursor_policy: "sidecar_reconstructed",
  audio_roles: [],
  evidence_artifact_sha256: sha,
  valid_from: "2026-07-21T00:00:00.000Z",
  valid_until: "2027-07-21T00:00:00.000Z",
  kill_switch_id: "switch",
};
const facts: RecordingV3CapabilityFacts = {
  platform: "darwin",
  arch: "arm64",
  hardwareModel: "Mac17,2",
  hardwareChip: "Apple M5",
  osBuild: "25F84",
  addonProtocolVersion: 3,
  manifestId: "manifest",
  matchedProfile: profile,
  sourceRate: {
    measured_fps: { numerator: 60, denominator: 1 },
    source_presentations: 60,
    sequence_gaps: 0,
    stale_reuses: 0,
    probe_duration_ms: 1_000,
  },
  storage: {
    estimated_bytes_per_second: 1,
    required_bytes_for_ten_minutes: 1,
    available_bytes: 10,
    reserve_bytes: 1,
  },
  storageEligible: true,
  nativeProbePassed: true,
  permissionsGranted: true,
};

describe("evaluateRecordingV3Capability", () => {
  it("enables only an exact signed-profile match", () => {
    const result = evaluateRecordingV3Capability(request, facts);
    expect(result).toMatchObject({
      runtime_eligible: true,
      certification_eligible: true,
      eligible: true,
      recording_mode: "strict_certified",
      failure_codes: [],
      matched_profile: profile,
    });
    expect(recordingV3QualificationFromPreflight(result)).toEqual({
      mode: "strict_certified",
      manifestId: "manifest",
      profile,
    });
  });

  const mismatches: Array<
    [
      string,
      { request: RecordingPreflightV3Request; facts: RecordingV3CapabilityFacts },
      RecordingFailureCodeV3,
    ]
  > = [
    ["target", { request: { ...request, target_class: "display" }, facts }, "target_unsupported"],
    [
      "audio",
      { request: { ...request, audio_roles: ["microphone"] }, facts },
      "unsupported_audio_role",
    ],
    ["native", { request, facts: { ...facts, nativeProbePassed: false } }, "addon_load_failed"],
    [
      "permission",
      { request, facts: { ...facts, permissionsGranted: false } },
      "permission_denied",
    ],
    [
      "storage",
      { request, facts: { ...facts, storageEligible: false } },
      "storage_preflight_failed",
    ],
    [
      "source",
      {
        request,
        facts: {
          ...facts,
          sourceRate: { ...facts.sourceRate, measured_fps: null, sequence_gaps: 1 },
        },
      },
      "runtime_integrity_failed",
    ],
    ["profile", { request, facts: { ...facts, matchedProfile: null } }, "profile_mismatch"],
    [
      "manifest",
      {
        request,
        facts: {
          ...facts,
          manifestId: null,
          matchedProfile: null,
          certificationFailureCodes: ["manifest_missing"],
        },
      },
      "manifest_missing",
    ],
  ];

  it.each(mismatches)("fails closed for %s mismatch", (_name, input, expected) => {
    const result = evaluateRecordingV3Capability(input.request, input.facts);
    expect(result.eligible).toBe(false);
    expect(result.failure_codes).toContain(expected);
  });

  it("enables Strict Local without certification while preserving common runtime gates", () => {
    const localRequest: RecordingPreflightV3Request = {
      ...request,
      certification_mode: "local",
      dimensions: recordingV3DimensionsForViewport("local", {
        width: 1280,
        height: 800,
      }),
    };
    const localFacts: RecordingV3CapabilityFacts = {
      ...facts,
      manifestId: null,
      matchedProfile: null,
    };
    const localResult = evaluateRecordingV3Capability(localRequest, localFacts);
    expect(localResult).toMatchObject({
      enforcement_mode: "strict",
      certification_mode: "local",
      recording_mode: "strict_local",
      manifest_id: null,
      matched_profile: null,
      runtime_eligible: true,
      certification_eligible: false,
      eligible: true,
      failure_codes: [],
    });
    expect(recordingV3QualificationFromPreflight(localResult)).toEqual({
      mode: "strict_local",
    });

    expect(evaluateRecordingV3Capability(localRequest, facts)).toMatchObject({
      recording_mode: "strict_local",
      manifest_id: null,
      matched_profile: null,
      runtime_eligible: true,
      certification_eligible: true,
      eligible: true,
      failure_codes: [],
    });

    const blockedLocal = evaluateRecordingV3Capability(localRequest, {
        ...localFacts,
        sourceRate: { ...localFacts.sourceRate, measured_fps: null },
      });
    expect(blockedLocal).toMatchObject({
      runtime_eligible: false,
      certification_eligible: false,
      eligible: false,
      failure_codes: ["runtime_integrity_failed"],
    });
    expect(recordingV3QualificationFromPreflight(blockedLocal)).toBeNull();

    for (const [width, height] of [
      [1280, 720],
      [1280, 800],
      [1440, 900],
      [1920, 1080],
    ]) {
      const candidate = {
        ...localRequest,
        dimensions: recordingV3DimensionsForViewport("local", { width, height }),
      };
      expect(evaluateRecordingV3Capability(candidate, localFacts)).toMatchObject({
        runtime_eligible: true,
        eligible: true,
        failure_codes: [],
      });
    }

    const certifiedWideRequest: RecordingPreflightV3Request = {
      ...request,
      dimensions: recordingV3DimensionsForViewport("certified", { width: 1280, height: 720 }),
    };
    expect(evaluateRecordingV3Capability(certifiedWideRequest, facts)).toMatchObject({
      runtime_eligible: false,
      certification_eligible: false,
      eligible: false,
      failure_codes: ["contract_mismatch"],
    });
  });
});

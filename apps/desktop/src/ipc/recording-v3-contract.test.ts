import { Buffer } from "node:buffer";
import {
  normalizeExportRecordingSource,
  normalizeRecordingBundle,
  type RecordingBundleV2,
  type RecordingBundleV3,
  type RecordingCadenceEvidenceV3,
  type RecordingCertifiedProfileV3,
  type RecordingFrameLedgerEntryV3,
  type RecordingQualityEvidenceV3,
  readExportRecordingSource,
  readRecordingBundle,
  readRecordingCadenceEvidenceV3,
  readRecordingCertifiedProfileV3,
  readRecordingEventV3,
  readRecordingFrameLedgerV3,
  readRecordingInfo,
  readRecordingPreflightV3Dto,
  readRecordingPreflightV3Request,
  readRecordingQualityEvidenceV3,
  readRecordingResult,
  readRecordingV3DevelopmentEnvironmentDto,
  readSignedRecordingCertificationManifestV3,
  recordingCertificationManifestValidAt,
  recordingCertifiedProfileEnabledAt,
} from "@storycapture/shared-types/recording-v2";
import { describe, expect, it } from "vitest";

const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);
const SIGNATURE = Buffer.alloc(64).toString("base64");
const FPS = { numerator: 60, denominator: 1 } as const;
const DIMENSIONS = {
  logical_width: 960,
  logical_height: 540,
  capture_dpr: 2,
  physical_width: 1920,
  physical_height: 1080,
  requested_output_width: 1920,
  requested_output_height: 1080,
} as const;

function profile(
  overrides: Partial<RecordingCertifiedProfileV3> = {},
): RecordingCertifiedProfileV3 {
  return {
    version: 3,
    profile_id: "mac17-2-m5-browser-1080p60",
    stage: "certified",
    target_class: "browser",
    platform: "darwin",
    arch: "arm64",
    hardware_model: "Mac17,2",
    hardware_chip: "Apple M5",
    os_build: "25F84",
    backend_id: "electron_offscreen_shared_texture_native_v3",
    backend_version: "3.0.0",
    addon_protocol_version: 1,
    addon_sha256: HASH,
    electron_version: "42.4.1",
    chromium_version: "148.0.7778.265",
    ffmpeg_version: "7.1",
    ffmpeg_sha256: SECOND_HASH,
    output_width: 1920,
    output_height: 1080,
    exact_fps: FPS,
    cursor_policy: "sidecar_reconstructed",
    audio_roles: [],
    evidence_artifact_sha256: HASH,
    valid_from: "2026-07-01T00:00:00.000Z",
    valid_until: "2026-08-01T00:00:00.000Z",
    kill_switch_id: "strict-browser-mac17-2",
    ...overrides,
  };
}

function signedManifest(disabledKillSwitchIds: string[] = []) {
  return {
    payload: {
      schema_version: 1,
      manifest_id: "manifest-2026-07",
      canonicalization: "RFC8785",
      signature_algorithm: "ed25519",
      signer_key_id: "release-2026",
      issued_at: "2026-07-01T00:00:00.000Z",
      valid_from: "2026-07-01T00:00:00.000Z",
      valid_until: "2026-08-01T00:00:00.000Z",
      disabled_kill_switch_ids: disabledKillSwitchIds,
      profiles: [profile()],
    },
    signature: SIGNATURE,
  } as const;
}

function ledgerEntry(
  ordinal: number,
  overrides: Partial<RecordingFrameLedgerEntryV3> = {},
): RecordingFrameLedgerEntryV3 {
  return {
    version: 3,
    source_epoch: 0,
    active_segment: 0,
    source_frame_count: ordinal - 1,
    source_timestamp_us: (ordinal - 1) * 16_667,
    active_time_pts_us: (ordinal - 1) * 16_667,
    delivery_ordinal: ordinal,
    native_lease_ordinal: ordinal,
    native_commit_ordinal: ordinal,
    encoded_ordinal: ordinal,
    decoded_ordinal: ordinal,
    bgra_sha256: HASH,
    ...overrides,
  };
}

function cadence(): RecordingCadenceEvidenceV3 {
  return {
    version: 3,
    guarantee_boundary: "electron_offscreen_delivery",
    source_ordinal_kind: "electron_frame_count",
    requested_fps: FPS,
    source_fps: FPS,
    stream_time_base: { numerator: 1, denominator: 60 },
    active_duration_us: 33_334,
    expected_slots: 2,
    source_presentations: 2,
    delivery_frames: 2,
    native_commits: 2,
    encoded_frames: 2,
    artifact_decoded_frames: 2,
    source_ordinal_gaps: 0,
    source_timestamp_regressions: 0,
    delivery_duplicates: 0,
    native_lease_overflows: 0,
    native_backpressure_events: 0,
    native_deadline_misses: 0,
    artifact_pts_gaps: 0,
    artifact_pts_duplicates: 0,
    full_decode_succeeded: true,
    verdict: "passed",
    failure_codes: [],
  };
}

function runtimeQuality(): RecordingQualityEvidenceV3 {
  return {
    version: 3,
    measurement_scope: "runtime_integrity",
    reference_identity: null,
    evaluated_frames: 2,
    full_frame_luma_ssim: null,
    text_edge_roi_ssim: null,
    p01_edge_contrast_retention: null,
    edge_spread_increase_px: null,
    overlay_geometry_delta_px: null,
    color_channel_delta: null,
    lossless_master_hashes_match: true,
    certification_verdict: null,
    verdict: "passed",
    failure_codes: [],
  };
}

function bundleV3(): RecordingBundleV3 {
  return {
    schema_version: 3,
    status: "completed",
    created_at: "2026-07-21T00:00:00.000Z",
    delivery_policy: "strict",
    recording_mode: "certified",
    certification_profile: {
      manifest_id: "manifest-2026-07",
      profile_id: profile().profile_id,
      evidence_artifact_sha256: HASH,
    },
    capture_contract: {
      version: 3,
      guarantee_boundary: "electron_offscreen_delivery",
      source_ordinal_kind: "electron_frame_count",
      target_class: "browser",
      exact_fps: FPS,
      dimensions: DIMENSIONS,
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
    },
    master: {
      relative_path: "master/video.mkv",
      bytes: 100,
      sha256: HASH,
      codec: "ffv1",
      pixel_format: "bgra",
      frame_count: 2,
      exact_fps: FPS,
    },
    proxy: {
      relative_path: "proxy/video.mp4",
      bytes: 50,
      sha256: SECOND_HASH,
      codec: "h264",
    },
    audio: [],
    evidence: {
      cadence_path: "evidence/cadence.json",
      runtime_quality_path: "evidence/runtime-quality.json",
      certification_quality_path: "evidence/certification-quality.json",
    },
    sidecars: {
      actions_path: "sidecars/actions.json",
      cursor_path: "sidecars/cursor.json",
    },
    frame_ledger_path: "evidence/frame-ledger.jsonl",
    diagnostics_manifest_path: "diagnostics/manifest.json",
    failure_codes: [],
  };
}

function developmentBundleV3(): RecordingBundleV3 {
  return {
    ...bundleV3(),
    delivery_policy: "development",
    recording_mode: "uncertified_development",
    certification_profile: null,
    evidence: {
      ...bundleV3().evidence,
      certification_quality_path: null,
    },
  };
}

function bundleV2(): RecordingBundleV2 {
  return {
    schema_version: 2,
    status: "completed",
    created_at: "2026-07-21T00:00:00.000Z",
    delivery_policy: "strict",
    certified_tier: null,
    capture_contract: { exact_fps: FPS, dimensions: DIMENSIONS },
    master: {
      relative_path: "master/video.mkv",
      bytes: 100,
      sha256: HASH,
      codec: "ffv1",
      pixel_format: "bgra",
      frame_count: 2,
      exact_fps: FPS,
    },
    proxy: {
      relative_path: "proxy/video.mp4",
      bytes: 50,
      sha256: SECOND_HASH,
      codec: "h264",
    },
    audio: [],
    evidence: {
      cadence_path: "evidence/cadence.json",
      quality_path: "evidence/quality.json",
    },
    sidecars: { actions_path: "sidecars/actions.json" },
    sequence_ledger_path: "evidence/sequence-ledger.jsonl",
    failure_codes: [],
  };
}

describe("Recording V3 contract", () => {
  it("parses exact profiles and signed manifest validity/kill-switch semantics", () => {
    expect(readRecordingCertifiedProfileV3(profile())).toEqual(profile());
    expect(readRecordingCertifiedProfileV3({ ...profile(), addon_sha256: "bad" })).toBeNull();
    expect(readRecordingCertifiedProfileV3({ ...profile(), valid_from: "2026-07-01" })).toBeNull();
    expect(readRecordingCertifiedProfileV3({ ...profile(), unexpected: true })).toBeNull();

    const manifest = readSignedRecordingCertificationManifestV3(signedManifest());
    expect(manifest).not.toBeNull();
    if (!manifest) throw new Error("Expected valid certification manifest");
    const now = Date.parse("2026-07-21T00:00:00.000Z");
    expect(recordingCertificationManifestValidAt(manifest, now)).toBe(true);
    expect(recordingCertifiedProfileEnabledAt(manifest, manifest.payload.profiles[0], now)).toBe(
      true,
    );

    const disabled = readSignedRecordingCertificationManifestV3(
      signedManifest([profile().kill_switch_id]),
    );
    expect(disabled).not.toBeNull();
    if (!disabled) throw new Error("Expected valid disabled certification manifest");
    expect(recordingCertifiedProfileEnabledAt(disabled, disabled.payload.profiles[0], now)).toBe(
      false,
    );
    expect(
      readSignedRecordingCertificationManifestV3({ ...signedManifest(), signature: "not-base64" }),
    ).toBeNull();
  });

  it("enforces epoch, active-segment and one-to-one ordinal ledger invariants", () => {
    const valid = [
      ledgerEntry(1),
      ledgerEntry(2),
      ledgerEntry(3, {
        active_segment: 1,
        source_frame_count: 10,
        source_timestamp_us: 200_000,
      }),
      ledgerEntry(4, {
        source_epoch: 1,
        active_segment: 2,
        source_frame_count: 0,
        source_timestamp_us: 0,
      }),
    ];
    expect(readRecordingFrameLedgerV3(valid)).toEqual(valid);
    expect(
      readRecordingFrameLedgerV3([ledgerEntry(1), ledgerEntry(2, { source_frame_count: 5 })]),
    ).toBeNull();
    expect(
      readRecordingFrameLedgerV3([ledgerEntry(1), ledgerEntry(2, { native_commit_ordinal: 1 })]),
    ).toBeNull();
    expect(
      readRecordingFrameLedgerV3([ledgerEntry(1), ledgerEntry(2, { source_timestamp_us: 0 })]),
    ).toBeNull();
  });

  it("keeps runtime integrity metrics null and requires fixture identity for measurements", () => {
    expect(readRecordingQualityEvidenceV3(runtimeQuality())).toEqual(runtimeQuality());
    expect(
      readRecordingQualityEvidenceV3({
        ...runtimeQuality(),
        full_frame_luma_ssim: {
          measured: 1,
          threshold: 0.99,
          comparator: "gte",
          passed: true,
        },
      }),
    ).toBeNull();

    const fixtureQuality = {
      ...runtimeQuality(),
      measurement_scope: "certification_fixture",
      reference_identity: {
        fixture_id: "browser-v3",
        fixture_version: "1",
        reference_sha256: HASH,
      },
      certification_verdict: "passed",
      full_frame_luma_ssim: {
        measured: 0.999,
        threshold: 0.99,
        comparator: "gte",
        passed: true,
      },
    } as const;
    expect(readRecordingQualityEvidenceV3(fixtureQuality)).toEqual(fixtureQuality);
    expect(
      readRecordingQualityEvidenceV3({ ...fixtureQuality, reference_identity: null }),
    ).toBeNull();
  });

  it("rejects artifact CFR evidence that hides source or native counter faults", () => {
    expect(readRecordingCadenceEvidenceV3(cadence())).toEqual(cadence());
    expect(
      readRecordingCadenceEvidenceV3({
        ...cadence(),
        source_presentations: 1,
      }),
    ).toBeNull();
    expect(
      readRecordingCadenceEvidenceV3({
        ...cadence(),
        source_timestamp_regressions: 1,
      }),
    ).toBeNull();
  });

  it("parses V3 bundle/export/result and keeps V2 normalization explicitly unverified", () => {
    expect(readRecordingBundle(bundleV3())).toEqual(bundleV3());
    expect(readRecordingBundle(developmentBundleV3())).toEqual(developmentBundleV3());
    expect(readRecordingBundle({ ...bundleV3(), audio: [{}] })).toBeNull();
    expect(readRecordingBundle({ ...bundleV3(), schema_version: 4 })).toBeNull();

    const { recording_mode: _legacyMode, ...legacyStrictBundle } = bundleV3();
    expect(readRecordingBundle(legacyStrictBundle)).toEqual({
      ...legacyStrictBundle,
      recording_mode: "certified",
    });
    expect(
      readRecordingBundle({
        ...bundleV3(),
        status: "quality_failed",
        certification_profile: null,
      }),
    ).toMatchObject({
      status: "quality_failed",
      delivery_policy: "strict",
      recording_mode: "certified",
      certification_profile: null,
    });
    expect(
      readRecordingBundle({
        ...developmentBundleV3(),
        status: "quality_failed",
        proxy: null,
      }),
    ).toMatchObject({
      status: "quality_failed",
      delivery_policy: "development",
      recording_mode: "uncertified_development",
      certification_profile: null,
    });
    expect(
      readRecordingBundle({
        ...developmentBundleV3(),
        recording_mode: "certified",
      }),
    ).toBeNull();
    expect(
      readRecordingBundle({
        ...bundleV3(),
        certification_profile: null,
      }),
    ).toBeNull();

    expect(normalizeRecordingBundle(bundleV2())).toMatchObject({
      source_version: 2,
      guarantee_boundary: null,
      source_scope_verified: false,
      certification_profile_id: null,
    });
    expect(normalizeRecordingBundle(bundleV3())).toMatchObject({
      source_version: 3,
      guarantee_boundary: "electron_offscreen_delivery",
      source_scope_verified: true,
      recording_mode: "certified",
      certification_profile_id: profile().profile_id,
    });

    const sourceV3 = {
      version: 3,
      bundle_path: "/bundle",
      master_path: "/bundle/master/video.mkv",
      proxy_path: "/bundle/proxy/video.mp4",
      cadence_evidence_path: "/bundle/evidence/cadence.json",
      quality_evidence_path: "/bundle/evidence/runtime-quality.json",
      frame_ledger_path: "/bundle/evidence/frame-ledger.jsonl",
      exact_source_fps: FPS,
      source_frame_count: 2,
      master_width: 1920,
      master_height: 1080,
      quality_verdict: "passed",
      guarantee_boundary: "electron_offscreen_delivery",
      source_scope_verified: true,
      recording_mode: "certified",
      certification_profile_id: profile().profile_id,
    } as const;
    expect(readExportRecordingSource(sourceV3)).toEqual(sourceV3);
    expect(normalizeExportRecordingSource(sourceV3)).toMatchObject({
      source_version: 3,
      source_scope_verified: true,
      recording_mode: "certified",
    });

    const developmentSourceV3 = {
      ...sourceV3,
      recording_mode: "uncertified_development",
      certification_profile_id: null,
    } as const;
    expect(readExportRecordingSource(developmentSourceV3)).toEqual(developmentSourceV3);

    const result = {
      version: 3,
      status: "completed",
      delivery_policy: "strict",
      recording_mode: "certified",
      guarantee_boundary: "electron_offscreen_delivery",
      certification_profile: bundleV3().certification_profile,
      bundle_path: "/bundle",
      output_path: "/bundle/proxy/video.mp4",
      diagnostic_bundle_path: null,
      duration_ms: 34,
      bytes: 100,
      master_path: "/bundle/master/video.mkv",
      proxy_path: "/bundle/proxy/video.mp4",
      cadence_evidence: cadence(),
      quality_evidence: runtimeQuality(),
    } as const;
    expect(readRecordingResult(result)).toEqual(result);
    expect(readRecordingEventV3({ type: "completed", result })).toEqual({
      type: "completed",
      result,
    });

    const developmentResult = {
      ...result,
      delivery_policy: "development",
      recording_mode: "uncertified_development",
      certification_profile: null,
    } as const;
    expect(readRecordingResult(developmentResult)).toEqual(developmentResult);
    expect(
      readRecordingResult({ ...developmentResult, recording_mode: "certified" }),
    ).toBeNull();
  });

  it("uses intent-only preflight requests and rejects unknown future info versions", () => {
    const request = {
      version: 3,
      intent: "strict",
      target_class: "browser",
      requested_fps: FPS,
      dimensions: DIMENSIONS,
      cursor_policy: "sidecar_reconstructed",
      audio_roles: ["microphone"],
    } as const;
    expect(readRecordingPreflightV3Request(request)).toEqual(request);
    expect(readRecordingPreflightV3Request({ ...request, intent: "development" })).toEqual({
      ...request,
      intent: "development",
    });
    expect(readRecordingPreflightV3Request({ ...request, intent: "best_effort" })).toBeNull();

    const developmentEnvironment = {
      version: 3,
      development_enabled: true,
      development_available: true,
      native_probe_passed: true,
      failure_codes: [],
    } as const;
    expect(readRecordingV3DevelopmentEnvironmentDto(developmentEnvironment)).toEqual(
      developmentEnvironment,
    );
    expect(
      readRecordingV3DevelopmentEnvironmentDto({
        ...developmentEnvironment,
        development_enabled: false,
      }),
    ).toBeNull();

    const blocked = {
      version: 3,
      intent: "strict",
      backend_id: "electron_offscreen_shared_texture_native_v3",
      backend_version: "3.0.0",
      addon_protocol_version: 1,
      platform: "darwin",
      arch: "arm64",
      hardware_model: "Mac17,2",
      hardware_chip: "Apple M5",
      os_build: "25F84",
      manifest_id: null,
      matched_profile: null,
      source_rate: {
        measured_fps: FPS,
        source_presentations: 60,
        sequence_gaps: 0,
        stale_reuses: 0,
        probe_duration_ms: 1_000,
      },
      storage: {
        estimated_bytes_per_second: 1,
        required_bytes_for_ten_minutes: 600,
        available_bytes: 1_000,
        reserve_bytes: 100,
      },
      native_probe_passed: true,
      permissions_granted: true,
      strict_eligible: false,
      development_eligible: false,
      recording_mode: "certified",
      failure_codes: ["unsupported_audio_role"],
    } as const;
    expect(readRecordingPreflightV3Dto(blocked)).toEqual(blocked);
    expect(
      readRecordingPreflightV3Dto({ ...blocked, strict_eligible: true, failure_codes: [] }),
    ).toBeNull();

    const developmentPreflight = {
      ...blocked,
      intent: "development",
      recording_mode: "uncertified_development",
      manifest_id: null,
      matched_profile: null,
      development_eligible: true,
      failure_codes: [],
    } as const;
    expect(readRecordingPreflightV3Dto(developmentPreflight)).toEqual(developmentPreflight);
    expect(
      readRecordingPreflightV3Dto({
        ...developmentPreflight,
        strict_eligible: true,
      }),
    ).toBeNull();

    expect(
      readRecordingInfo({
        version: 3,
        path: "/bundle/proxy/video.mp4",
        captured_at: 1,
        duration_ms: 1,
        width: 1920,
        height: 1080,
        master_path: "/bundle/master/video.mkv",
        proxy_path: "/bundle/proxy/video.mp4",
        cadence_evidence_path: "/bundle/evidence/cadence.json",
        quality_evidence_path: "/bundle/evidence/runtime-quality.json",
        frame_ledger_path: "/bundle/evidence/frame-ledger.jsonl",
        actions_path: null,
        cursor_path: null,
        exact_source_fps: FPS,
        source_frame_count: 1,
        recording_mode: "uncertified_development",
        certification_profile: null,
        guarantee_boundary: "electron_offscreen_delivery",
        source_scope_verified: true,
        quality_verdict: "passed",
        bundle_path: "/bundle",
      }),
    ).toMatchObject({
      recording_mode: "uncertified_development",
      certification_profile: null,
    });

    expect(readRecordingInfo({ version: 4, path: "/future", captured_at: 1 })).toBeNull();
    expect(readRecordingInfo({ path: "/legacy", captured_at: 1 })).toMatchObject({
      version: 2,
      bundle_path: null,
    });
  });
});

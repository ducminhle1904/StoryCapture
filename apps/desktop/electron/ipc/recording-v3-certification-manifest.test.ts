import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

import type {
  RecordingCertificationManifestPayloadV3,
  RecordingCertifiedProfileV3,
} from "@storycapture/shared-types/recording-v2";
import { describe, expect, it } from "vitest";

import { canonicalizeRecordingCertificationJson } from "./recording-v3-certification-canonical-json";
import {
  type RecordingCertificationRuntimeIdentityV3,
  recordingCertificationProfileMatchesRuntimeV3,
  resolveRecordingCertificationProfileV3,
  verifyRecordingCertificationManifestV3,
} from "./recording-v3-certification-manifest";

const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const shaC = "c".repeat(64);
const validFrom = "2026-07-21T00:00:00.000Z";
const validUntil = "2026-08-21T00:00:00.000Z";
const nowMs = Date.parse("2026-07-22T00:00:00.000Z");

const profile: RecordingCertifiedProfileV3 = {
  version: 3,
  profile_id: "browser-mac17-2-m5-2026-07",
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
  addon_sha256: shaA,
  electron_version: "42.4.1",
  chromium_version: "148.0.7778.265",
  ffmpeg_version: "7.1.1",
  ffmpeg_sha256: shaB,
  output_width: 1920,
  output_height: 1080,
  exact_fps: { numerator: 60, denominator: 1 },
  cursor_policy: "sidecar_reconstructed",
  audio_roles: [],
  evidence_artifact_sha256: shaC,
  valid_from: validFrom,
  valid_until: validUntil,
  kill_switch_id: "recording-v3-browser-mac17-2",
};

const runtime: RecordingCertificationRuntimeIdentityV3 = {
  target_class: profile.target_class,
  platform: profile.platform,
  arch: profile.arch,
  hardware_model: profile.hardware_model,
  hardware_chip: profile.hardware_chip,
  os_build: profile.os_build,
  backend_id: profile.backend_id,
  backend_version: profile.backend_version,
  addon_protocol_version: profile.addon_protocol_version,
  addon_sha256: profile.addon_sha256,
  electron_version: profile.electron_version,
  chromium_version: profile.chromium_version,
  ffmpeg_version: profile.ffmpeg_version,
  ffmpeg_sha256: profile.ffmpeg_sha256,
  output_width: profile.output_width,
  output_height: profile.output_height,
  exact_fps: profile.exact_fps,
  cursor_policy: profile.cursor_policy,
  audio_roles: [],
  evidence_artifact_sha256: profile.evidence_artifact_sha256,
};

function manifestPayload(
  overrides: Partial<RecordingCertificationManifestPayloadV3> = {},
): RecordingCertificationManifestPayloadV3 {
  return {
    schema_version: 1,
    manifest_id: "recording-v3-2026-07",
    canonicalization: "RFC8785",
    signature_algorithm: "ed25519",
    signer_key_id: "release-2026-07",
    issued_at: validFrom,
    valid_from: validFrom,
    valid_until: validUntil,
    disabled_kill_switch_ids: [],
    profiles: [profile],
    ...overrides,
  };
}

function signedManifest(payload: RecordingCertificationManifestPayloadV3, privateKey: KeyObject) {
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalizeRecordingCertificationJson(payload)),
      privateKey,
    ).toString("base64"),
  };
}

describe("recording V3 certification canonical JSON", () => {
  it("orders object keys recursively while preserving array order", () => {
    expect(canonicalizeRecordingCertificationJson({ z: 1, a: { y: 2, b: [3, 1] } })).toBe(
      '{"a":{"b":[3,1],"y":2},"z":1}',
    );
  });

  it("rejects values outside the JSON data model", () => {
    const sparse = [1];
    sparse.length = 3;
    sparse[2] = 2;
    expect(() => canonicalizeRecordingCertificationJson({ invalid: undefined })).toThrow();
    expect(() => canonicalizeRecordingCertificationJson(Number.NaN)).toThrow();
    expect(() => canonicalizeRecordingCertificationJson(new Date())).toThrow();
    expect(() => canonicalizeRecordingCertificationJson(sparse)).toThrow();
    expect(() => canonicalizeRecordingCertificationJson({ [Symbol("invalid")]: 1 })).toThrow();
  });
});

describe("recording V3 signed certification manifest", () => {
  it("accepts only the canonical payload signed by the mapped key ID", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = manifestPayload();
    const manifest = signedManifest(payload, privateKey);

    expect(
      verifyRecordingCertificationManifestV3(
        manifest,
        { [payload.signer_key_id]: publicKey },
        nowMs,
      ),
    ).toEqual({ manifest, failure_codes: [] });
    expect(
      verifyRecordingCertificationManifestV3(
        { ...manifest, payload: { ...payload, manifest_id: "tampered" } },
        { [payload.signer_key_id]: publicKey },
        nowMs,
      ).failure_codes,
    ).toEqual(["manifest_signature_invalid"]);
    expect(verifyRecordingCertificationManifestV3(manifest, {}, nowMs).failure_codes).toEqual([
      "manifest_signature_invalid",
    ]);
  });

  it("fails closed for validity, kill switch, non-certified stage, and exact profile count", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keys = { "release-2026-07": publicKey };
    const before = signedManifest(manifestPayload(), privateKey);
    expect(
      resolveRecordingCertificationProfileV3({
        manifest: before,
        runtime,
        signerKeys: keys,
        nowMs: Date.parse("2026-07-20T00:00:00.000Z"),
      }).failure_codes,
    ).toEqual(["manifest_not_yet_valid"]);

    const killed = signedManifest(
      manifestPayload({ disabled_kill_switch_ids: [profile.kill_switch_id] }),
      privateKey,
    );
    expect(
      resolveRecordingCertificationProfileV3({ manifest: killed, runtime, signerKeys: keys, nowMs })
        .failure_codes,
    ).toEqual(["tier_kill_switch_disabled"]);
    const enabled = signedManifest(manifestPayload(), privateKey);
    expect(
      resolveRecordingCertificationProfileV3({
        manifest: enabled,
        runtime,
        signerKeys: keys,
        disabledKillSwitchIds: new Set([profile.kill_switch_id]),
        nowMs,
      }).failure_codes,
    ).toEqual(["tier_kill_switch_disabled"]);

    const internal = signedManifest(
      manifestPayload({ profiles: [{ ...profile, stage: "internal" }] }),
      privateKey,
    );
    expect(
      resolveRecordingCertificationProfileV3({
        manifest: internal,
        runtime,
        signerKeys: keys,
        nowMs,
      }).failure_codes,
    ).toEqual(["profile_mismatch"]);
  });
});

describe("recording V3 exact runtime profile matcher", () => {
  it("rejects a mismatch in every pinned runtime field", () => {
    expect(recordingCertificationProfileMatchesRuntimeV3(profile, runtime)).toBe(true);
    const mismatches: RecordingCertificationRuntimeIdentityV3[] = [
      { ...runtime, target_class: "display" },
      { ...runtime, platform: "win32" },
      { ...runtime, arch: "x64" },
      { ...runtime, hardware_model: "Mac17,1" },
      { ...runtime, hardware_chip: "Apple M4" },
      { ...runtime, os_build: "25F83" },
      { ...runtime, backend_id: "other" },
      { ...runtime, backend_version: "3.0.1" },
      { ...runtime, addon_protocol_version: 4 },
      { ...runtime, addon_sha256: shaB },
      { ...runtime, electron_version: "42.4.0" },
      { ...runtime, chromium_version: "148.0.0.0" },
      { ...runtime, ffmpeg_version: "7.1.0" },
      { ...runtime, ffmpeg_sha256: shaA },
      { ...runtime, output_width: 1919 },
      { ...runtime, output_height: 1079 },
      { ...runtime, exact_fps: { numerator: 30, denominator: 1 } },
      { ...runtime, exact_fps: { numerator: 60, denominator: 2 } },
      { ...runtime, cursor_policy: "other" as never },
      { ...runtime, audio_roles: ["microphone"] as never },
      { ...runtime, evidence_artifact_sha256: shaA },
    ];
    for (const mismatch of mismatches) {
      expect(recordingCertificationProfileMatchesRuntimeV3(profile, mismatch)).toBe(false);
    }
  });

  it("resolves exactly one certified matching profile", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const manifest = signedManifest(manifestPayload(), privateKey);
    expect(
      resolveRecordingCertificationProfileV3({
        manifest,
        runtime,
        signerKeys: { "release-2026-07": publicKey },
        nowMs,
      }),
    ).toMatchObject({ manifest, profile, failure_codes: [] });
  });
});

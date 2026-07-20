import type {
  CaptureBackendV2Capabilities,
  RecordingCertifiedTier,
} from "@storycapture/shared-types/recording-v2";
import { describe, expect, it } from "vitest";
import {
  disabledRecordingCertificationTierIds,
  findRecordingCertificationTier,
  recordingCertificationTierMatches,
} from "./recording-certification-catalog";

const capabilities: CaptureBackendV2Capabilities = {
  version: 2,
  backend_id: "electron_offscreen_shared_texture",
  backend_version: "1",
  target_classes: ["browser"],
  supports_native_timestamps: true,
  supports_source_sequences: true,
  supports_physical_pixels: true,
  supports_cursor_policy: true,
  supports_pause_resume: true,
};

const certified: RecordingCertifiedTier = {
  version: 2,
  id: "browser-darwin-arm64-fixture",
  stage: "certified",
  target_class: "browser",
  platform: "darwin",
  arch: "arm64",
  backend_id: capabilities.backend_id,
  backend_version: capabilities.backend_version,
  hardware_fingerprint: "fixture",
  exact_fps: { numerator: 60, denominator: 1 },
  output_width: 1920,
  output_height: 1080,
};

describe("recording certification catalogue", () => {
  it("matches every pinned backend, hardware, cadence, and output field", () => {
    const lookup = {
      platform: "darwin" as const,
      arch: "arm64",
      hardwareFingerprint: "fixture",
      targetClass: "browser" as const,
      capabilities,
      outputWidth: 1920,
      outputHeight: 1080,
    };
    expect(findRecordingCertificationTier(lookup, [certified])).toEqual(certified);
    expect(
      findRecordingCertificationTier({ ...lookup, hardwareFingerprint: "other" }, [certified]),
    ).toBeNull();
    expect(
      findRecordingCertificationTier(lookup, [{ ...certified, stage: "internal" }]),
    ).toBeNull();
  });

  it("keeps the bundled catalogue fail-closed until release certification adds entries", () => {
    expect(
      findRecordingCertificationTier({
        platform: "darwin",
        arch: "arm64",
        hardwareFingerprint: "unknown",
        targetClass: "browser",
        capabilities,
        outputWidth: 1920,
        outputHeight: 1080,
      }),
    ).toBeNull();
  });

  it("honors the tier-specific rollback switch without inventing a Standard certification", () => {
    const lookup = {
      platform: "darwin" as const,
      arch: "arm64",
      hardwareFingerprint: "fixture",
      targetClass: "browser" as const,
      capabilities,
      outputWidth: 1920,
      outputHeight: 1080,
    };
    const disabled = disabledRecordingCertificationTierIds(`other, ${certified.id}`);
    expect(findRecordingCertificationTier(lookup, [certified], disabled)).toBeNull();
    expect(recordingCertificationTierMatches(certified, lookup, disabled)).toBe(false);
  });
});

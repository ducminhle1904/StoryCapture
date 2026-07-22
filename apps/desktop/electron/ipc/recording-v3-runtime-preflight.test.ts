import {
  type RecordingPreflightV3Request,
  recordingV3DimensionsForViewport,
} from "@storycapture/shared-types/recording-v3";
import { describe, expect, it } from "vitest";

import {
  evaluateRecordingV3DevelopmentEnvironment,
  recordingV3SourceMetadataFailure,
} from "./recording-v3-runtime-preflight";

describe("Recording V3 development environment", () => {
  it("reports source-independent availability from the common runtime gates", () => {
    expect(
      evaluateRecordingV3DevelopmentEnvironment({
        developmentEnabled: true,
        nativeProbePassed: true,
        storageEligible: true,
        failureCodes: [],
      }),
    ).toEqual({
      version: 3,
      development_enabled: true,
      development_available: true,
      native_probe_passed: true,
      failure_codes: [],
    });
  });

  it("validates source texture format and coded size against the request", () => {
    const request: RecordingPreflightV3Request = {
      version: 3,
      intent: "development",
      target_class: "browser",
      requested_fps: { numerator: 60, denominator: 1 },
      dimensions: recordingV3DimensionsForViewport("development", {
        width: 1280,
        height: 800,
      }),
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
    };
    expect(
      recordingV3SourceMetadataFailure(request, {
        widgetType: "frame",
        codedSize: { width: 1280, height: 800 },
        pixelFormat: "bgra",
      }),
    ).toBeNull();
    expect(
      recordingV3SourceMetadataFailure(request, {
        widgetType: "frame",
        codedSize: { width: 1920, height: 1080 },
        pixelFormat: "bgra",
      }),
    ).toBe("source_metadata_invalid");
    expect(
      recordingV3SourceMetadataFailure(request, {
        widgetType: "frame",
        codedSize: { width: 1280, height: 800 },
        pixelFormat: "rgba",
      }),
    ).toBe("source_metadata_invalid");
  });

  it("keeps the option unavailable when the gate or a common runtime check fails", () => {
    expect(
      evaluateRecordingV3DevelopmentEnvironment({
        developmentEnabled: false,
        nativeProbePassed: true,
        storageEligible: true,
        failureCodes: [],
      }).development_available,
    ).toBe(false);
    expect(
      evaluateRecordingV3DevelopmentEnvironment({
        developmentEnabled: true,
        nativeProbePassed: true,
        storageEligible: false,
        failureCodes: ["storage_preflight_failed"],
      }),
    ).toMatchObject({
      development_enabled: true,
      development_available: false,
      failure_codes: ["storage_preflight_failed"],
    });
  });
});

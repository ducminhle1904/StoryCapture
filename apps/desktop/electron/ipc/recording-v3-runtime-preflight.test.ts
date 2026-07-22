import { describe, expect, it } from "vitest";

import { evaluateRecordingV3DevelopmentEnvironment } from "./recording-v3-runtime-preflight";

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

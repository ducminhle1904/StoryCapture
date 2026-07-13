import { describe, expect, it } from "vitest";
import { DEFAULT_POLISH_DOC, normalizePolishDoc } from "./polish-sidecar";

describe("polish-sidecar motion normalization", () => {
  it("defaults new projects to cinematic Full Motion", () => {
    expect(DEFAULT_POLISH_DOC.global).toMatchObject({
      motionMode: "full",
      autoZoomDurationMs: 1_600,
    });
  });

  it("migrates legacy data to Full Motion and enforces the zoom minimum", () => {
    expect(
      normalizePolishDoc({
        version: 2,
        global: { autoZoomDurationMs: 100 },
        scenes: {},
        steps: {},
      }).global,
    ).toMatchObject({ motionMode: "full", autoZoomDurationMs: 900 });
  });

  it("preserves Reduced Motion", () => {
    expect(
      normalizePolishDoc({
        version: 2,
        global: { motionMode: "reduced" },
        scenes: {},
        steps: {},
      }).global.motionMode,
    ).toBe("reduced");
  });
});

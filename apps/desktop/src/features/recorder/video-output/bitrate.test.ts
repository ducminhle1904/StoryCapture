/**
 * Bitrate preview helpers + custom-dims validator.
 */

import { describe, expect, it } from "vitest";

import {
  computeBitratePreview,
  formatBitratePreview,
  resolveDims,
  validateCustomDims,
} from "./bitrate";

describe("computeBitratePreview", () => {
  it("1080p med → ~6.2 Mbps ~45 MB/min", () => {
    const out = computeBitratePreview({ w: 1920, h: 1080, quality: "med" });
    expect(out.mbps).toBeCloseTo(6.22, 1);
    expect(out.mbPerMin).toBeCloseTo(45.56, 1);
  });

  it("4K lossless → ~37.3 Mbps ~273 MB/min", () => {
    const out = computeBitratePreview({ w: 3840, h: 2160, quality: "lossless" });
    expect(out.mbps).toBeCloseTo(37.32, 1);
    expect(out.mbPerMin).toBeCloseTo(273, 0);
  });

  it("zero dims → zero bitrate (no NaN)", () => {
    const out = computeBitratePreview({ w: 0, h: 0, quality: "med" });
    expect(out.mbps).toBe(0);
    expect(out.mbPerMin).toBe(0);
  });
});

describe("formatBitratePreview", () => {
  it("formats with one-decimal Mbps + integer MB/min", () => {
    expect(formatBitratePreview(6.22, 45)).toBe("~6.2 Mbps • ~45 MB/min");
  });
});

describe("resolveDims", () => {
  it("p1080 → 1920×1080", () => {
    expect(resolveDims({ kind: "p1080" })).toEqual({ w: 1920, h: 1080 });
  });

  it("custom passes through", () => {
    expect(resolveDims({ kind: "custom", w: 1280, h: 720 })).toEqual({ w: 1280, h: 720 });
  });

  it("match-source uses supplied capture dims", () => {
    expect(resolveDims({ kind: "match-source" }, { w: 1600, h: 900 })).toEqual({
      w: 1600,
      h: 900,
    });
  });
});

describe("validateCustomDims", () => {
  it("odd width is invalid", () => {
    expect(validateCustomDims(1281, 720)).toEqual({ valid: false, reason: "odd-width" });
  });

  it("out-of-range width is invalid", () => {
    expect(validateCustomDims(8000, 720)).toEqual({ valid: false, reason: "out-of-range" });
  });

  it("even within range is valid", () => {
    expect(validateCustomDims(1920, 1080)).toEqual({ valid: true });
  });
});

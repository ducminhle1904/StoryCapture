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
  it("1080p standard → ~7.8 Mbps ~57 MB/min", () => {
    const out = computeBitratePreview({ w: 1920, h: 1080, fps: 60, quality: "high" });
    expect(out.mbps).toBeCloseTo(7.78, 1);
    expect(out.mbPerMin).toBeCloseTo(56.95, 1);
  });

  it("4K lossless → ~37.3 Mbps ~273 MB/min", () => {
    const out = computeBitratePreview({ w: 3840, h: 2160, fps: 60, quality: "lossless" });
    expect(out.mbps).toBeCloseTo(37.32, 1);
    expect(out.mbPerMin).toBeCloseTo(273, 0);
  });

  it("30fps estimates half of 60fps", () => {
    const sixty = computeBitratePreview({ w: 1920, h: 1080, fps: 60, quality: "high" });
    const thirty = computeBitratePreview({ w: 1920, h: 1080, fps: 30, quality: "high" });
    expect(thirty.mbps).toBeCloseTo(sixty.mbps / 2, 2);
    expect(thirty.mbPerMin).toBeCloseTo(sixty.mbPerMin / 2, 2);
  });

  it("zero dims → zero bitrate (no NaN)", () => {
    const out = computeBitratePreview({ w: 0, h: 0, fps: 60, quality: "high" });
    expect(out.mbps).toBe(0);
    expect(out.mbPerMin).toBe(0);
  });

  it("invalid fps → zero bitrate (no NaN)", () => {
    const out = computeBitratePreview({ w: 1920, h: 1080, fps: 0, quality: "high" });
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

/**
 * Unit tests — deriveQualityControls decision table (Phase 13 Plan 05 Task 1).
 * Covers UI-SPEC lines 206-216 per-encoder quality-control shape.
 */

import { describe, expect, it } from "vitest";

import { deriveQualityControls } from "./encoder-options-table";

describe("deriveQualityControls", () => {
  it("software → CRF slider 0..51 default 18 + 9 x264 presets", () => {
    const r = deriveQualityControls("software", "h264");
    expect(r.rateControlOptions.map((o) => o.value)).toEqual(["crf", "cbr", "vbr"]);
    expect(r.qualityControl).toMatchObject({ kind: "slider-crf", min: 0, max: 51, default: 18 });
    expect(r.presetOptions).toHaveLength(9);
  });

  it("h264-nvenc → VBR locked + CQ slider default 19 + p1..p7 presets", () => {
    const r = deriveQualityControls("h264-nvenc", "h264");
    expect(r.rateControlOptions).toEqual([{ value: "vbr", locked: true }]);
    expect(r.qualityControl).toMatchObject({ kind: "slider-cq", min: 0, max: 51, default: 19 });
    expect(r.presetOptions).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  });

  it("h264-videotoolbox → VBR only + bitrate Mbps + speed/quality presets", () => {
    const r = deriveQualityControls("h264-videotoolbox", "h264");
    expect(r.rateControlOptions.map((o) => o.value)).toEqual(["vbr"]);
    expect(r.qualityControl.kind).toBe("number-bitrate-mbps");
    expect(r.presetOptions).toEqual(["speed", "quality"]);
  });

  it("auto → hides all quality/preset controls with explanatory note", () => {
    const r = deriveQualityControls("auto", "h264");
    expect(r.qualityControl.kind).toBe("auto-hide");
    if (r.qualityControl.kind === "auto-hide") {
      expect(r.qualityControl.note).toMatch(/Encoder sẽ được chọn lúc export/);
    }
    expect(r.rateControlOptions).toHaveLength(0);
    expect(r.presetOptions).toHaveLength(0);
  });

  it("libopenh264 → bitrate Mbps default 4 + empty presets + fallback note", () => {
    const r = deriveQualityControls("libopenh264", "h264");
    expect(r.qualityControl).toMatchObject({ kind: "number-bitrate-mbps", default: 4 });
    expect(r.presetOptions).toHaveLength(0);
    expect(r.note).toMatch(/Fallback/);
  });

  it("h264-qsv → VBR/CBR + bitrate Mbps + qsv preset list", () => {
    const r = deriveQualityControls("h264-qsv", "h264");
    expect(r.rateControlOptions.map((o) => o.value)).toEqual(["vbr", "cbr"]);
    expect(r.qualityControl.kind).toBe("number-bitrate-mbps");
    expect(r.presetOptions).toEqual(["veryfast", "faster", "fast", "medium", "slow", "slower"]);
  });
});

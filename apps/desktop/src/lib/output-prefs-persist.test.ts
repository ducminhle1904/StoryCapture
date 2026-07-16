import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_KNOBS,
  DEFAULT_RECORDING_PACING,
  PRESET_BUNDLES,
} from "@/state/output-prefs";

import { migrate, type PersistShape, resolveOverride } from "./output-prefs-persist";

const SEED = migrate(null);

describe("migrate", () => {
  it("returns the silent seed for null input", () => {
    expect(migrate(null)).toEqual(SEED);
  });

  it("returns a valid shape unchanged", () => {
    const input: PersistShape = {
      activePreset: "Lossless",
      recordingKnobs: PRESET_BUNDLES.Lossless,
      recordingPacing: DEFAULT_RECORDING_PACING,
      exportKnobs: DEFAULT_EXPORT_KNOBS,
      version: 2,
    };
    expect(migrate(input)).toEqual(input);
  });

  it("falls back to Standard for unknown presets", () => {
    const out = migrate({ activePreset: "Experimental" } as unknown);
    expect(out.activePreset).toBe("Standard");
    expect(out.recordingKnobs).toEqual(PRESET_BUNDLES.Standard);
  });

  it("fills missing fields from seed", () => {
    const out = migrate({ activePreset: "Standard" } as unknown);
    expect(out.activePreset).toBe("Standard");
    expect(out.recordingPacing).toBe("normal");
    expect(out.recordingKnobs).toEqual(PRESET_BUNDLES.Standard);
    expect(out.exportKnobs).toEqual(SEED.exportKnobs);
    expect(out.version).toBe(2);
  });

  it("rejects unsupported quality values in custom recording knobs", () => {
    const out = migrate({
      activePreset: "Custom",
      recordingKnobs: { ...PRESET_BUNDLES.Standard, quality: "archived" },
    } as unknown);
    expect(out.activePreset).toBe("Custom");
    expect(out.recordingKnobs.quality).toBe(PRESET_BUNDLES.Standard.quality);
  });

  it("keeps pacing fixed at the 1x profile", () => {
    const out = migrate({ recordingPacing: "speedy" } as unknown);
    expect(out.recordingPacing).toBe(DEFAULT_RECORDING_PACING);
  });

  it("bumps version from 0 to 2", () => {
    const out = migrate({
      activePreset: "Standard",
      recordingKnobs: PRESET_BUNDLES.Standard,
      exportKnobs: DEFAULT_EXPORT_KNOBS,
      version: 0,
    } as unknown);
    expect(out.version).toBe(2);
  });

  it("normalizes legacy MP4 audio to the delivery contract", () => {
    const out = migrate({
      exportKnobs: {
        ...DEFAULT_EXPORT_KNOBS,
        container: "mp4",
        audio: { codec: "aac", bitrateKbps: 160, channels: 1, sampleRateHz: 44_100 },
      },
      version: 1,
    });

    expect(out.exportKnobs.audio).toEqual(DEFAULT_EXPORT_KNOBS.audio);
  });

  it("propagates user qualityValue", () => {
    const out = migrate({ exportKnobs: { qualityValue: 19 } } as unknown);
    expect(out.exportKnobs.qualityValue).toBe(19);
    expect(out.exportKnobs.container).toBe(SEED.exportKnobs.container);
  });

  it("silent-seed sets qualityValue to null", () => {
    expect(migrate(null).exportKnobs.qualityValue).toBeNull();
  });

  it("reads legacy preset and downscale fields but returns only the canonical shape", () => {
    const out = migrate({
      exportKnobs: { x264Preset: "slow", downscaleAlgo: "bicubic" },
      version: 1,
    } as unknown);

    expect(out.exportKnobs.encoderPreset).toBe("slow");
    expect(out.exportKnobs.resamplingQuality).toBe("balanced");
    expect(out.exportKnobs).not.toHaveProperty("x264Preset");
    expect(out.exportKnobs).not.toHaveProperty("downscaleAlgo");
  });
});

describe("resolveOverride", () => {
  it("project fps overrides global but keeps global quality", () => {
    const out = resolveOverride(SEED, {
      recordingKnobs: { ...SEED.recordingKnobs, fps: 48 },
    });
    expect(out.recordingKnobs.fps).toBe(48);
    expect(out.recordingKnobs.quality).toBe(SEED.recordingKnobs.quality);
  });

  it("ignores project pacing overrides", () => {
    const out = resolveOverride(SEED, { recordingPacing: "slowmo" });
    expect(out.recordingPacing).toBe(DEFAULT_RECORDING_PACING);
  });

  it("returns global when project override is null", () => {
    expect(resolveOverride(SEED, null)).toEqual(SEED);
  });
});

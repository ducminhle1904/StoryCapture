import { describe, expect, it } from "vitest";

import { DEFAULT_EXPORT_KNOBS, PRESET_BUNDLES } from "@/state/output-prefs";

import { type PersistShape, migrate, resolveOverride } from "./output-prefs-persist";

const SEED: PersistShape = {
  activePreset: "Standard",
  recordingKnobs: PRESET_BUNDLES.Standard,
  exportKnobs: DEFAULT_EXPORT_KNOBS,
  version: 1,
};

describe("migrate", () => {
  it("returns the silent seed for null input", () => {
    expect(migrate(null)).toEqual(SEED);
  });

  it("returns a valid shape unchanged", () => {
    const input: PersistShape = {
      activePreset: "Quick",
      recordingKnobs: PRESET_BUNDLES.Quick,
      exportKnobs: DEFAULT_EXPORT_KNOBS,
      version: 1,
    };
    expect(migrate(input)).toEqual(input);
  });

  it("fills missing fields from seed", () => {
    const out = migrate({ activePreset: "Quick" } as unknown);
    expect(out.activePreset).toBe("Quick");
    expect(out.recordingKnobs).toEqual(SEED.recordingKnobs);
    expect(out.exportKnobs).toEqual(SEED.exportKnobs);
    expect(out.version).toBe(1);
  });

  it("bumps version from 0 to 1", () => {
    const out = migrate({
      activePreset: "Standard",
      recordingKnobs: PRESET_BUNDLES.Standard,
      exportKnobs: DEFAULT_EXPORT_KNOBS,
      version: 0,
    } as unknown);
    expect(out.version).toBe(1);
  });

  it("propagates user qualityValue", () => {
    const out = migrate({ exportKnobs: { qualityValue: 19 } } as unknown);
    expect(out.exportKnobs.qualityValue).toBe(19);
    expect(out.exportKnobs.container).toBe(SEED.exportKnobs.container);
  });

  it("silent-seed sets qualityValue to null", () => {
    expect(migrate(null).exportKnobs.qualityValue).toBeNull();
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

  it("returns global when project override is null", () => {
    expect(resolveOverride(SEED, null)).toEqual(SEED);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_KNOBS,
  PRESET_BUNDLES,
  matchPreset,
  useOutputPrefsStore,
} from "./output-prefs";

function resetStore() {
  useOutputPrefsStore.setState({
    activePreset: "Standard",
    recordingKnobs: PRESET_BUNDLES.Standard,
    exportKnobs: DEFAULT_EXPORT_KNOBS,
  });
}

describe("useOutputPrefsStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("starts in Standard with bundled knobs + default export bag", () => {
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Standard");
    expect(s.recordingKnobs).toEqual(PRESET_BUNDLES.Standard);
    expect(s.exportKnobs).toEqual(DEFAULT_EXPORT_KNOBS);
  });

  it("applyPreset('Quick') swaps recordingKnobs to the Quick bundle", () => {
    useOutputPrefsStore.getState().applyPreset("Quick");
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Quick");
    expect(s.recordingKnobs).toEqual(PRESET_BUNDLES.Quick);
  });

  it("flips to Custom when fps=24 breaks every bundle", () => {
    useOutputPrefsStore.getState().applyPreset("Standard");
    useOutputPrefsStore.getState().setRecordingKnob("fps", 24);
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Custom");
    expect(s.recordingKnobs.fps).toBe(24);
  });

  it("lands back on a named preset when individual knobs happen to match one", () => {
    useOutputPrefsStore.getState().applyPreset("Standard");
    useOutputPrefsStore.getState().setRecordingKnob("fps", 60);
    useOutputPrefsStore.getState().setRecordingKnob("quality", "high");
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("High Quality");
    expect(s.recordingKnobs).toEqual(PRESET_BUNDLES["High Quality"]);
  });

  it("setExportKnob does not touch activePreset", () => {
    useOutputPrefsStore.getState().applyPreset("Standard");
    useOutputPrefsStore.getState().setExportKnob("keyframeSec", 5);
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Standard");
    expect(s.exportKnobs.keyframeSec).toBe(5);
  });

  it("re-applying the same value keeps the named preset", () => {
    useOutputPrefsStore.getState().applyPreset("Quick");
    useOutputPrefsStore
      .getState()
      .setRecordingKnob("resolution", { kind: "p720" });
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Quick");
  });

  it("setRecordingKnob rejects wrong value types at compile time", () => {
    // @ts-expect-error — fps must be a number
    useOutputPrefsStore.getState().setRecordingKnob("fps", "thirty");
  });
});

describe("matchPreset", () => {
  it("returns the bundle name for a known shape", () => {
    expect(matchPreset(PRESET_BUNDLES.Quick)).toBe("Quick");
    expect(matchPreset(PRESET_BUNDLES.Standard)).toBe("Standard");
    expect(matchPreset(PRESET_BUNDLES["High Quality"])).toBe("High Quality");
  });

  it("returns null for a shape outside the bundles", () => {
    expect(
      matchPreset({
        resolution: { kind: "p1080" },
        fps: 24,
        fit: "letterbox",
        pad: { kind: "black" },
        quality: "med",
      }),
    ).toBeNull();
  });
});

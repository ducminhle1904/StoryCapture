import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_KNOBS,
  DEFAULT_RECORDING_PACING,
  matchPreset,
  PRESET_BUNDLES,
  recordingOutputResolutionForStart,
  useOutputPrefsStore,
} from "./output-prefs";

function resetStore() {
  useOutputPrefsStore.setState({
    activePreset: "Standard",
    recordingKnobs: PRESET_BUNDLES.Standard,
    recordingPacing: DEFAULT_RECORDING_PACING,
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
    expect(s.recordingPacing).toBe(DEFAULT_RECORDING_PACING);
    expect(s.exportKnobs).toEqual(DEFAULT_EXPORT_KNOBS);
  });

  it("keeps recording pacing fixed at 1x", () => {
    useOutputPrefsStore.getState().setRecordingPacing("speedy" as never);
    expect(useOutputPrefsStore.getState().recordingPacing).toBe(DEFAULT_RECORDING_PACING);
  });

  it("applyPreset('Lossless') swaps recordingKnobs to the Lossless bundle", () => {
    useOutputPrefsStore.getState().applyPreset("Lossless");
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Lossless");
    expect(s.recordingKnobs).toEqual(PRESET_BUNDLES.Lossless);
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
    useOutputPrefsStore.getState().setRecordingKnob("quality", "lossless");
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Lossless");
    expect(s.recordingKnobs).toEqual(PRESET_BUNDLES.Lossless);
  });

  it("setExportKnob does not touch activePreset", () => {
    useOutputPrefsStore.getState().applyPreset("Standard");
    useOutputPrefsStore.getState().setExportKnob("keyframeSec", 5);
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Standard");
    expect(s.exportKnobs.keyframeSec).toBe(5);
  });

  it("re-applying the same value keeps the named preset", () => {
    useOutputPrefsStore.getState().applyPreset("Lossless");
    useOutputPrefsStore.getState().setRecordingKnob("quality", "lossless");
    const s = useOutputPrefsStore.getState();
    expect(s.activePreset).toBe("Lossless");
  });

  it("setRecordingKnob rejects wrong value types at compile time", () => {
    // @ts-expect-error — fps must be a number
    useOutputPrefsStore.getState().setRecordingKnob("fps", "thirty");
  });
});

describe("matchPreset", () => {
  it("returns the bundle name for a known shape", () => {
    expect(matchPreset(PRESET_BUNDLES.Standard)).toBe("Standard");
    expect(matchPreset(PRESET_BUNDLES.Lossless)).toBe("Lossless");
  });

  it("returns null for a shape outside the bundles", () => {
    expect(
      matchPreset({
        resolution: { kind: "match-source" },
        fps: 24,
        fit: "letterbox",
        pad: { kind: "black" },
        quality: "high",
      }),
    ).toBeNull();
  });
});

describe("recordingOutputResolutionForStart", () => {
  it("keeps Standard and Lossless source-sized explicitly", () => {
    expect(recordingOutputResolutionForStart(PRESET_BUNDLES.Standard, "Standard")).toEqual({
      kind: "match-source",
    });
    expect(recordingOutputResolutionForStart(PRESET_BUNDLES.Lossless, "Lossless")).toEqual({
      kind: "match-source",
    });
  });

  it("keeps Custom resolution explicit", () => {
    expect(recordingOutputResolutionForStart(PRESET_BUNDLES.Standard, "Custom")).toEqual({
      kind: "match-source",
    });
  });
});

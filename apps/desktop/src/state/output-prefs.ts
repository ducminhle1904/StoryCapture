import type {
  FitModeDto,
  OutputResolutionDto,
  PadColorDto,
  QualityPresetDto,
} from "@storycapture/shared-types";
/**
 * Shared output-prefs store. Cross-feature: consumed by the Recording View
 * (5 knobs) AND the Export Modal (8 export-only knobs on top).
 *
 * Phase 13 — second documented slice-composition exception (see docs/CONVENTIONS.md).
 */
import { create } from "zustand";

export type PresetName = "Quick" | "Standard" | "High Quality" | "Custom";

export interface RecordingKnobs {
  resolution: OutputResolutionDto;
  fps: number;
  fit: FitModeDto;
  pad: PadColorDto;
  quality: QualityPresetDto;
}

export interface AudioKnobs {
  codec: "aac" | "opus";
  bitrateKbps: number;
  channels: 1 | 2;
  sampleRateHz: number;
}

export type ExportContainer = "mp4" | "mov" | "webm";
export type ExportCodec = "h264";
export type ExportRateControl = "auto" | "cbr" | "vbr" | "crf" | "cq";
export type ExportX264Preset =
  | "ultrafast"
  | "superfast"
  | "veryfast"
  | "faster"
  | "fast"
  | "medium"
  | "slow"
  | "slower"
  | "veryslow";
export type ExportDownscaleAlgo = "lanczos" | "bicubic" | "bilinear";

export interface ExportKnobs {
  container: ExportContainer;
  codec: ExportCodec;
  rateControl: ExportRateControl;
  /** `"auto"` | `"software"` | a probed HW encoder name. Free-form at the
   *  UI layer; Plan 13-05 maps it to HardwareEncoderDto for IPC. */
  hwEncoder: string;
  x264Preset: ExportX264Preset;
  keyframeSec: number;
  downscaleAlgo: ExportDownscaleAlgo;
  audio: AudioKnobs;
  /** Discriminated by (codec, hwEncoder, rateControl) via Plan 13-05's
   *  deriveQualityControls(). Null = Phase 12 pixel_based default (CD-13-04). */
  qualityValue: number | null;
}

export const PRESET_BUNDLES: Record<Exclude<PresetName, "Custom">, RecordingKnobs> = {
  Quick: {
    resolution: { kind: "p720" },
    fps: 30,
    fit: "letterbox",
    pad: { kind: "black" },
    quality: "low",
  },
  Standard: {
    resolution: { kind: "p1080" },
    fps: 30,
    fit: "letterbox",
    pad: { kind: "black" },
    quality: "med",
  },
  "High Quality": {
    resolution: { kind: "p1080" },
    fps: 60,
    fit: "letterbox",
    pad: { kind: "black" },
    quality: "high",
  },
};

export const DEFAULT_EXPORT_KNOBS: ExportKnobs = {
  container: "mp4",
  codec: "h264",
  rateControl: "auto",
  hwEncoder: "auto",
  x264Preset: "medium",
  keyframeSec: 2,
  downscaleAlgo: "lanczos",
  audio: { codec: "aac", bitrateKbps: 160, channels: 2, sampleRateHz: 48_000 },
  qualityValue: null,
};

export function matchPreset(knobs: RecordingKnobs): Exclude<PresetName, "Custom"> | null {
  for (const [name, bundle] of Object.entries(PRESET_BUNDLES)) {
    if (deepEqual(knobs, bundle)) return name as Exclude<PresetName, "Custom">;
  }
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface State {
  activePreset: PresetName;
  recordingKnobs: RecordingKnobs;
  exportKnobs: ExportKnobs;
  setRecordingKnob<K extends keyof RecordingKnobs>(k: K, v: RecordingKnobs[K]): void;
  setExportKnob<K extends keyof ExportKnobs>(k: K, v: ExportKnobs[K]): void;
  applyPreset(name: Exclude<PresetName, "Custom">): void;
  hydrate(s: {
    activePreset: PresetName;
    recordingKnobs: RecordingKnobs;
    exportKnobs: ExportKnobs;
  }): void;
}

export const useOutputPrefsStore = create<State>((set) => ({
  activePreset: "Standard",
  recordingKnobs: PRESET_BUNDLES.Standard,
  exportKnobs: DEFAULT_EXPORT_KNOBS,
  setRecordingKnob: (k, v) =>
    set((s) => {
      const next = { ...s.recordingKnobs, [k]: v };
      const matched = matchPreset(next);
      return { recordingKnobs: next, activePreset: matched ?? "Custom" };
    }),
  setExportKnob: (k, v) => set((s) => ({ exportKnobs: { ...s.exportKnobs, [k]: v } })),
  applyPreset: (name) => set({ activePreset: name, recordingKnobs: PRESET_BUNDLES[name] }),
  hydrate: ({ activePreset, recordingKnobs, exportKnobs }) =>
    set({ activePreset, recordingKnobs, exportKnobs }),
}));

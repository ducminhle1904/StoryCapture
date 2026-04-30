import type {
  FitModeDto,
  OutputResolutionDto,
  PadColorDto,
  QualityPresetDto,
} from "@storycapture/shared-types";
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
  hwEncoder: string;
  x264Preset: ExportX264Preset;
  keyframeSec: number;
  downscaleAlgo: ExportDownscaleAlgo;
  audio: AudioKnobs;
  qualityValue: number | null;
}

export const PRESET_BUNDLES: Record<
  Exclude<PresetName, "Custom">,
  RecordingKnobs
> = {
  Quick: {
    resolution: { kind: "p720" },
    fps: 30,
    fit: "letterbox",
    pad: { kind: "black" },
    quality: "low",
  },
  Standard: {
    resolution: { kind: "match-source" },
    fps: 30,
    fit: "letterbox",
    pad: { kind: "black" },
    quality: "med",
  },
  "High Quality": {
    resolution: { kind: "match-source" },
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

export function matchPreset(
  knobs: RecordingKnobs,
): Exclude<PresetName, "Custom"> | null {
  for (const [name, bundle] of Object.entries(PRESET_BUNDLES)) {
    if (knobsEqual(knobs, bundle)) return name as Exclude<PresetName, "Custom">;
  }
  return null;
}

export function recordingOutputResolutionForStart(
  knobs: RecordingKnobs,
  activePreset?: PresetName,
): OutputResolutionDto | undefined {
  void activePreset;
  return knobs.resolution;
}

function knobsEqual(a: RecordingKnobs, b: RecordingKnobs): boolean {
  return (
    a.fps === b.fps &&
    a.fit === b.fit &&
    a.quality === b.quality &&
    resolutionEqual(a.resolution, b.resolution) &&
    padEqual(a.pad, b.pad)
  );
}

function resolutionEqual(
  a: OutputResolutionDto,
  b: OutputResolutionDto,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "custom" && b.kind === "custom") {
    return a.w === b.w && a.h === b.h;
  }
  return true;
}

function padEqual(a: PadColorDto, b: PadColorDto): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "custom" && b.kind === "custom") {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  return true;
}

interface State {
  activePreset: PresetName;
  recordingKnobs: RecordingKnobs;
  exportKnobs: ExportKnobs;
  setRecordingKnob<K extends keyof RecordingKnobs>(
    k: K,
    v: RecordingKnobs[K],
  ): void;
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
      if (s.recordingKnobs[k] === v) return s;
      const next = { ...s.recordingKnobs, [k]: v };
      const matched = matchPreset(next);
      return { recordingKnobs: next, activePreset: matched ?? "Custom" };
    }),
  setExportKnob: (k, v) =>
    set((s) => {
      if (s.exportKnobs[k] === v) return s;
      return { exportKnobs: { ...s.exportKnobs, [k]: v } };
    }),
  applyPreset: (name) =>
    set({ activePreset: name, recordingKnobs: PRESET_BUNDLES[name] }),
  hydrate: ({ activePreset, recordingKnobs, exportKnobs }) =>
    set({ activePreset, recordingKnobs, exportKnobs }),
}));

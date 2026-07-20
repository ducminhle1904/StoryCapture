/**
 * Export slice. Holds transient form state for the Export modal. Formats
 * is an array (multi-select checkbox group); resolution / fps / quality
 * are single-select. `outFolder` is chosen via the native file dialog
 * and stashed here so the user doesn't re-pick it between opens.
 */

import type { StateCreator } from "zustand";

import type { ExportFormat, ExportQuality, ExportResolution } from "../../../ipc/export";

export type { ExportFormat, ExportQuality, ExportResolution };

export type ExportFrameMode = "source" | "framed";

export interface ExportFormState {
  formats: ExportFormat[];
  resolution: ExportResolution;
  customWidth: number;
  customHeight: number;
  fps: number;
  quality: ExportQuality;
  frameMode: ExportFrameMode;
  outFolder: string | null;
  baseName: string;
}

export interface ExportSlice {
  exportForm: ExportFormState;
  setExportFormats: (formats: ExportFormat[]) => void;
  setExportResolution: (r: ExportResolution) => void;
  setExportCustomSize: (size: { width: number; height: number }) => void;
  setExportFps: (fps: number) => void;
  setExportQuality: (q: ExportQuality) => void;
  setExportFrameMode: (mode: ExportFrameMode) => void;
  setExportOutFolder: (folder: string | null) => void;
  setExportBaseName: (name: string) => void;
  resetExportForm: () => void;
}

export const DEFAULT_EXPORT_FORM: ExportFormState = {
  formats: ["mp4"],
  resolution: "match-source",
  customWidth: 1920,
  customHeight: 1080,
  fps: 60,
  quality: "high",
  frameMode: "source",
  outFolder: null,
  baseName: "export",
};

export const createExportSlice: StateCreator<ExportSlice, [], [], ExportSlice> = (set) => ({
  exportForm: { ...DEFAULT_EXPORT_FORM },
  setExportFormats: (formats) =>
    set((s) =>
      s.exportForm.formats.length === formats.length &&
      s.exportForm.formats.every((format, index) => format === formats[index])
        ? s
        : { exportForm: { ...s.exportForm, formats } },
    ),
  setExportResolution: (resolution) =>
    set((s) =>
      s.exportForm.resolution === resolution ? s : { exportForm: { ...s.exportForm, resolution } },
    ),
  setExportCustomSize: ({ width, height }) =>
    set((s) =>
      s.exportForm.customWidth === width && s.exportForm.customHeight === height
        ? s
        : { exportForm: { ...s.exportForm, customWidth: width, customHeight: height } },
    ),
  setExportFps: (fps) =>
    set((s) => (s.exportForm.fps === fps ? s : { exportForm: { ...s.exportForm, fps } })),
  setExportQuality: (quality) =>
    set((s) =>
      s.exportForm.quality === quality ? s : { exportForm: { ...s.exportForm, quality } },
    ),
  setExportFrameMode: (frameMode) =>
    set((s) =>
      s.exportForm.frameMode === frameMode ? s : { exportForm: { ...s.exportForm, frameMode } },
    ),
  setExportOutFolder: (outFolder) =>
    set((s) =>
      s.exportForm.outFolder === outFolder ? s : { exportForm: { ...s.exportForm, outFolder } },
    ),
  setExportBaseName: (baseName) =>
    set((s) =>
      s.exportForm.baseName === baseName ? s : { exportForm: { ...s.exportForm, baseName } },
    ),
  resetExportForm: () => set({ exportForm: { ...DEFAULT_EXPORT_FORM } }),
});

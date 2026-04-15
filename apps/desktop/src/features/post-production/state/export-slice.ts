/**
 * Export slice (Plan 02-12a).
 *
 * Holds the transient form state for the Export modal. Formats is an
 * array (multi-select checkbox group); resolution / fps / quality are
 * single-select. `outFolder` is chosen via the native file dialog and
 * stashed here so the user doesn't re-pick it between opens.
 */

import type { StateCreator } from "zustand";

export type ExportFormat = "mp4" | "webm" | "gif";
export type ExportResolution = "720p" | "1080p" | "4k";
export type ExportQuality = "low" | "med" | "high";

export interface ExportFormState {
  formats: ExportFormat[];
  resolution: ExportResolution;
  fps: number;
  quality: ExportQuality;
  outFolder: string | null;
  baseName: string;
}

export interface ExportSlice {
  exportForm: ExportFormState;
  setExportFormats: (formats: ExportFormat[]) => void;
  setExportResolution: (r: ExportResolution) => void;
  setExportFps: (fps: number) => void;
  setExportQuality: (q: ExportQuality) => void;
  setExportOutFolder: (folder: string | null) => void;
  setExportBaseName: (name: string) => void;
  resetExportForm: () => void;
}

const DEFAULT_FORM: ExportFormState = {
  formats: ["mp4"],
  resolution: "1080p",
  fps: 60,
  quality: "high",
  outFolder: null,
  baseName: "export",
};

export const createExportSlice: StateCreator<ExportSlice, [], [], ExportSlice> = (
  set,
) => ({
  exportForm: { ...DEFAULT_FORM },
  setExportFormats: (formats) =>
    set((s) => ({ exportForm: { ...s.exportForm, formats } })),
  setExportResolution: (resolution) =>
    set((s) => ({ exportForm: { ...s.exportForm, resolution } })),
  setExportFps: (fps) => set((s) => ({ exportForm: { ...s.exportForm, fps } })),
  setExportQuality: (quality) =>
    set((s) => ({ exportForm: { ...s.exportForm, quality } })),
  setExportOutFolder: (outFolder) =>
    set((s) => ({ exportForm: { ...s.exportForm, outFolder } })),
  setExportBaseName: (baseName) =>
    set((s) => ({ exportForm: { ...s.exportForm, baseName } })),
  resetExportForm: () => set({ exportForm: { ...DEFAULT_FORM } }),
});

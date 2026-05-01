/**
 * Panels slice. Owns resizable-pane sizes (timeline height, preview
 * width, inspector width) and modal/drawer visibility. Persisted to
 * `localStorage` so layout preferences survive reloads. The `persist`
 * middleware lives on the store composition (see `store.ts`) to keep
 * this slice pure / testable.
 */

import type { StateCreator } from "zustand";

export const PANELS_STORAGE_KEY = "storycapture.post-production.panels";

export interface PanelsSlice {
  /** % of editor height given to the timeline. Defaults to 30. */
  timelineHeightPct: number;
  /** % of editor width given to the preview pane. Defaults to 74. The
   * inspector's width is derived as `100 - previewWidthPct` at the
   * shell level. */
  previewWidthPct: number;
  soundDrawerOpen: boolean;
  exportModalOpen: boolean;

  setTimelineHeightPct: (pct: number) => void;
  setPreviewWidthPct: (pct: number) => void;
  setSoundDrawerOpen: (open: boolean) => void;
  setExportModalOpen: (open: boolean) => void;
}

const clampPct = (n: number) => Math.max(10, Math.min(90, n));

export const createPanelsSlice: StateCreator<PanelsSlice, [], [], PanelsSlice> = (set) => ({
  timelineHeightPct: 30,
  previewWidthPct: 74,
  soundDrawerOpen: false,
  exportModalOpen: false,

  setTimelineHeightPct: (pct) => set({ timelineHeightPct: clampPct(pct) }),
  setPreviewWidthPct: (pct) => set({ previewWidthPct: clampPct(pct) }),
  setSoundDrawerOpen: (open) => set({ soundDrawerOpen: open }),
  setExportModalOpen: (open) => set({ exportModalOpen: open }),
});

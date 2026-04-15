/**
 * Post-Production editor store (Plan 02-12a, D-32).
 *
 * Composition of 5 slices (timeline / panels / selection / export / queue)
 * into a single Zustand store. The panels slice is persisted to
 * `localStorage` via `zustand/middleware/persist` so pane sizes and
 * drawer flags survive reloads. Timeline / selection / export / queue
 * are transient — a reload starts clean.
 *
 * The undo bridge is a module-level export, not a slice (it's stateless
 * in P12a and will hold its own history buffer in P13).
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { createExportSlice, type ExportSlice } from "./export-slice";
import { createPanelsSlice, PANELS_STORAGE_KEY, type PanelsSlice } from "./panels-slice";
import { createQueueSlice, type QueueSlice } from "./queue-slice";
import { createSelectionSlice, type SelectionSlice } from "./selection-slice";
import { createTimelineSlice, type TimelineSlice } from "./timeline-slice";

export type EditorStore = TimelineSlice &
  PanelsSlice &
  SelectionSlice &
  ExportSlice &
  QueueSlice;

/**
 * Keys from `PanelsSlice` that are worth persisting. We deliberately
 * exclude `soundDrawerOpen` / `exportModalOpen` — those are transient
 * UI states that shouldn't pop open on reload.
 */
const PERSISTED_PANEL_KEYS = [
  "timelineHeightPct",
  "previewWidthPct",
  "inspectorWidthPct",
] as const;

export const useEditorStore = create<EditorStore>()(
  persist(
    (...a) => ({
      ...createTimelineSlice(...a),
      ...createPanelsSlice(...a),
      ...createSelectionSlice(...a),
      ...createExportSlice(...a),
      ...createQueueSlice(...a),
    }),
    {
      name: PANELS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => {
        const out: Record<string, unknown> = {};
        for (const k of PERSISTED_PANEL_KEYS) {
          out[k] = state[k];
        }
        return out;
      },
      version: 1,
    },
  ),
);

export {
  dispatchUndoable,
  canRedo,
  canUndo,
  type UndoableAction,
  type DispatchResult,
} from "./undo-bridge";

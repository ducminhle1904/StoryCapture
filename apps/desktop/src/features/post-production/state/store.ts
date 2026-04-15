/**
 * Post-Production editor store (Plan 02-12a, D-32; Plan 02-13 added
 * UndoSlice).
 *
 * Composition of 6 slices:
 *   - timeline / panels / selection / export / queue (P12a)
 *   - undo (P13) — owns the HistoryBuffer + Coalescer
 *
 * The panels slice is persisted to `localStorage` via
 * `zustand/middleware/persist` so pane sizes and drawer flags survive
 * reloads. Timeline / selection / export / queue / undo are transient.
 * The undo ring is NOT persisted (D-16) — reloading the project resets
 * history.
 *
 * The undo-bridge module re-exports the slice's pushAction as
 * `dispatchUndoable` so P12a's call sites continue to compile without
 * changes; see `undo-bridge.ts`.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { createExportSlice, type ExportSlice } from "./export-slice";
import { createPanelsSlice, PANELS_STORAGE_KEY, type PanelsSlice } from "./panels-slice";
import { createQueueSlice, type QueueSlice } from "./queue-slice";
import { createSelectionSlice, type SelectionSlice } from "./selection-slice";
import { createTimelineSlice, type TimelineSlice } from "./timeline-slice";
import { createUndoSlice, type UndoSlice } from "./undo-slice";

export type EditorStore = TimelineSlice &
  PanelsSlice &
  SelectionSlice &
  ExportSlice &
  QueueSlice &
  UndoSlice;

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
      ...createUndoSlice(...a),
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
  type UndoableAction as LegacyUndoableAction,
  type DispatchResult,
} from "./undo-bridge";

/**
 * Post-Production editor store. Composition of 6 slices: timeline, panels,
 * selection, export, queue, undo (owns the HistoryBuffer + Coalescer).
 *
 * The panels slice is persisted to `localStorage` so pane sizes and
 * drawer flags survive reloads; timeline / selection / export / queue /
 * undo are transient. The undo ring is NOT persisted — reloading the
 * project resets history.
 *
 * Call sites push undoable actions via
 * `useEditorStore.getState().pushAction(action)`.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { UndoExtras } from "../undo/actions";
import { createExportSlice, DEFAULT_EXPORT_FORM, type ExportSlice } from "./export-slice";
import { createPanelsSlice, PANELS_STORAGE_KEY, type PanelsSlice } from "./panels-slice";
import { createQueueSlice, type QueueSlice } from "./queue-slice";
import { createSelectionSlice, type SelectionSlice } from "./selection-slice";
import { createTimelineSlice, type TimelineSlice } from "./timeline-slice";
import { createUndoSlice, type UndoSlice } from "./undo-slice";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type EditorBackgroundKind =
  | { kind: "transparent" }
  | { kind: "solid"; color: Rgba }
  | { kind: "gradient"; preset_id: string }
  | { kind: "image"; path: string };

export type EditorStore = TimelineSlice &
  PanelsSlice &
  SelectionSlice &
  ExportSlice &
  QueueSlice &
  UndoSlice & {
    _undoExtras?: UndoExtras & { background: EditorBackgroundKind };
  };

export const DEFAULT_BACKGROUND: EditorBackgroundKind = { kind: "transparent" };

export function readEditorBackground(state: {
  _undoExtras?: { background?: EditorBackgroundKind };
}): EditorBackgroundKind {
  return (state._undoExtras?.background as EditorBackgroundKind | undefined) ?? DEFAULT_BACKGROUND;
}

/**
 * Keys from `PanelsSlice` that are worth persisting. We deliberately
 * exclude `soundDrawerOpen` / `exportModalOpen` — those are transient
 * UI states that shouldn't pop open on reload.
 */
const PERSISTED_PANEL_KEYS = ["timelineHeightPct", "previewWidthPct"] as const;

/**
 * Persist the export form so user choices (formats, resolution, fps,
 * quality, output folder, base name) survive modal close + app reload.
 * Transient export state — `submitting`, validation `warnings`, queue
 * progress, and `exportModalOpen` — is intentionally excluded.
 */
const PERSISTED_EXPORT_KEYS = ["exportForm"] as const;

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
        for (const k of PERSISTED_EXPORT_KEYS) {
          out[k] = state[k];
        }
        return out;
      },
      // Defensive merge: if a persisted v1 payload (no `exportForm`) or a
      // partial `exportForm` is rehydrated, fill missing fields from
      // `DEFAULT_EXPORT_FORM` so future schema additions don't strand the
      // form in an undefined state.
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<EditorStore> & {
          exportForm?: Partial<EditorStore["exportForm"]>;
        };
        if (p.exportForm) {
          p.exportForm = { ...p.exportForm, frameMode: "framed" };
        }
        return p;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<EditorStore> & {
          exportForm?: Partial<EditorStore["exportForm"]>;
        };
        return {
          ...current,
          ...p,
          exportForm: {
            ...DEFAULT_EXPORT_FORM,
            ...current.exportForm,
            ...(p.exportForm ?? {}),
            frameMode: p.exportForm?.frameMode ?? "framed",
          },
        };
      },
      version: 4,
    },
  ),
);

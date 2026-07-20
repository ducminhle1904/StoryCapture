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

import {
  EXPORT_FOREGROUND_SCALE_DEFAULT,
  EXPORT_FOREGROUND_SCALE_MAX,
  EXPORT_FOREGROUND_SCALE_MIN,
} from "@storycapture/shared-types";
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

export const MIN_FOREGROUND_SCALE = EXPORT_FOREGROUND_SCALE_MIN;
export const MAX_FOREGROUND_SCALE = EXPORT_FOREGROUND_SCALE_MAX;
export const DEFAULT_FOREGROUND_SCALE = EXPORT_FOREGROUND_SCALE_DEFAULT;

export function sanitizeForegroundScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_FOREGROUND_SCALE;
  }
  return Math.min(MAX_FOREGROUND_SCALE, Math.max(MIN_FOREGROUND_SCALE, value));
}

type EditorBackgroundVisual =
  | { kind: "transparent" }
  | { kind: "solid"; color: Rgba }
  | { kind: "gradient"; preset_id: string }
  | {
      kind: "image";
      /** Stable id for bundled assets; null denotes a user-provided local file. */
      assetId: string | null;
      /** Legacy/runtime locator kept until the asset resolver has materialized the id. */
      path: string;
    };

export type EditorBackgroundKind = EditorBackgroundVisual & {
  foregroundScale: number;
};

export type EditorStore = TimelineSlice &
  PanelsSlice &
  SelectionSlice &
  ExportSlice &
  QueueSlice &
  UndoSlice & {
    _undoExtras?: UndoExtras & { background: EditorBackgroundKind };
    setForegroundScale: (scale: number) => void;
  };

export const DEFAULT_BACKGROUND: EditorBackgroundKind = {
  kind: "transparent",
  foregroundScale: DEFAULT_FOREGROUND_SCALE,
};

export function readEditorBackground(state: {
  _undoExtras?: {
    background?: EditorBackgroundVisual & { foregroundScale?: unknown };
  };
}): EditorBackgroundKind {
  const background = state._undoExtras?.background;
  if (!background) return DEFAULT_BACKGROUND;
  const foregroundScale = sanitizeForegroundScale(background.foregroundScale);
  if (background.foregroundScale === foregroundScale) {
    return background as EditorBackgroundKind;
  }
  return {
    ...background,
    foregroundScale,
  } as EditorBackgroundKind;
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

export function restoredExportFrameMode(
  persisted: Partial<EditorStore["exportForm"]> | undefined,
): EditorStore["exportForm"]["frameMode"] {
  if (!persisted) return DEFAULT_EXPORT_FORM.frameMode;
  return persisted.frameMode === "source" || persisted.frameMode === "framed"
    ? persisted.frameMode
    : "framed";
}

export const useEditorStore = create<EditorStore>()(
  persist(
    (...a) => {
      const [set] = a;
      return {
        ...createTimelineSlice(...a),
        ...createPanelsSlice(...a),
        ...createSelectionSlice(...a),
        ...createExportSlice(...a),
        ...createQueueSlice(...a),
        ...createUndoSlice(...a),
        setForegroundScale: (scale) =>
          set((state) => {
            const background = readEditorBackground(state);
            return {
              _undoExtras: {
                ...(state._undoExtras ?? {
                  graphSnapshot: {},
                  textOverlays: {},
                  background: DEFAULT_BACKGROUND,
                }),
                background: {
                  ...background,
                  foregroundScale: sanitizeForegroundScale(scale),
                },
              },
            };
          }),
      };
    },
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
          p.exportForm = {
            ...p.exportForm,
            frameMode: restoredExportFrameMode(p.exportForm),
          };
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
            frameMode: restoredExportFrameMode(p.exportForm),
          },
        };
      },
      version: 5,
    },
  ),
);

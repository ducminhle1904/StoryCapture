/**
 * Timeline snapping helper. Fixes a 10-pixel threshold. The timeline
 * slice's `moveClip` applies snap internally with its own computed px→ms
 * factor; this module is a thin re-export + a display-layer convenience
 * helper used by the drag/drop code in `timeline.tsx` / `clip.tsx`.
 *
 * Callers should prefer `useEditorStore.getState().moveClip(..., { pxPerMs })`
 * for the authoritative path; `snapX` exists so UI preview (ghost clip
 * while dragging) can mirror the same computation without pre-committing
 * state.
 */

import { snapToNearest } from "../state/timeline-slice";

// 10-pixel snap threshold. Re-declared here (matching the store's
// exported literal) so the display-layer grep target is explicit.
export const SNAP_THRESHOLD_PX = 10;

/**
 * Snap `candidateMs` toward the nearest target in `targets` if it falls
 * within 10 px (converted to ms via `pxPerMs`). Returns the (possibly
 * snapped) value in milliseconds.
 */
export function snapX(candidateMs: number, targets: readonly number[], pxPerMs: number): number {
  const thresholdMs = SNAP_THRESHOLD_PX / Math.max(pxPerMs, Number.EPSILON);
  return snapToNearest(candidateMs, targets, thresholdMs);
}

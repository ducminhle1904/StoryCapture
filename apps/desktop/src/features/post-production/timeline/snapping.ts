/**
 * Timeline snapping helper (Plan 02-12b, D-13).
 *
 * D-13 fixes a 10-pixel threshold. Because the timeline slice's
 * `moveClip` applies snap internally with its own computed px→ms factor,
 * this module is a thin re-export + a display-layer convenience helper
 * used by the drag/drop code in `timeline.tsx` / `clip.tsx`.
 *
 * Callers should prefer `useEditorStore.getState().moveClip(..., { pxPerMs })`
 * for the authoritative path; `snapX` exists so UI preview (ghost clip while
 * dragging) can mirror the same computation without pre-committing state.
 */

import {
  SNAP_THRESHOLD_PX,
  snapToNearest,
} from "../state/timeline-slice";

export { SNAP_THRESHOLD_PX };

/**
 * Snap `candidateMs` toward the nearest target in `targets` if it falls
 * within 10 px (converted to ms via `pxPerMs`). Returns the (possibly
 * snapped) value in milliseconds.
 */
export function snapX(
  candidateMs: number,
  targets: readonly number[],
  pxPerMs: number,
): number {
  const thresholdMs = SNAP_THRESHOLD_PX / Math.max(pxPerMs, Number.EPSILON);
  return snapToNearest(candidateMs, targets, thresholdMs);
}

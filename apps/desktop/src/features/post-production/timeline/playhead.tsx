/**
 * Playhead (Plan 02-12b).
 *
 * Vertical line rendered on top of the track stack. Position is derived
 * from the store's `playheadMs` + the display's `pxPerMs`. Dragging the
 * playhead is handled by the parent Timeline via pointer events on the
 * ruler; this component is a pure presentational marker.
 */

import { memo } from "react";

import { useEditorStore } from "../state/store";

export interface PlayheadProps {
  pxPerMs: number;
  height: number;
}

function PlayheadBase({ pxPerMs, height }: PlayheadProps) {
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const left = playheadMs * pxPerMs;

  return (
    <div
      role="separator"
      aria-label={`Playhead at ${(playheadMs / 1000).toFixed(2)} seconds`}
      aria-valuenow={Math.round(playheadMs)}
      className="pointer-events-none absolute top-0 z-10"
      style={{ left, height }}
    >
      <div className="h-full w-px bg-[var(--color-accent,#ff5b76)]" />
      <div className="absolute -top-1 -left-1 h-2 w-2 rotate-45 bg-[var(--color-accent,#ff5b76)]" />
    </div>
  );
}

export const Playhead = memo(PlayheadBase);

/**
 * Playhead — vertical line on top of the track stack. Position derives
 * from the store's `playheadMs` + the display's `pxPerMs`. Dragging is
 * handled by the parent Timeline via pointer events on the ruler; this
 * component is a pure presentational marker.
 */

import { memo } from "react";

import { useEditorStore } from "../state/store";

export interface PlayheadProps {
  pxPerMs: number;
  height: number;
}

function PlayheadBase({ pxPerMs, height }: PlayheadProps) {
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const translateX = playheadMs * pxPerMs;
  const label = `Playhead at ${(playheadMs / 1000).toFixed(2)} seconds`;

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 z-10 will-change-transform"
        style={{ height, transform: `translate3d(${translateX}px, 0, 0)` }}
      >
        <div className="h-full w-px bg-[var(--color-accent,#ff5b76)]" />
        <div className="absolute -top-1 -left-1 h-2 w-2 rotate-45 bg-[var(--color-accent,#ff5b76)]" />
      </div>
      <output className="sr-only" aria-live="off">
        {label}
      </output>
    </>
  );
}

export const Playhead = memo(PlayheadBase);

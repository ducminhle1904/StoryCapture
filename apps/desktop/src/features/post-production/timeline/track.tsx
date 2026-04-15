/**
 * Timeline track row (Plan 02-12b).
 *
 * Renders one of the 5 fixed tracks (D-12) with its clips laid out in
 * absolute position according to `pxPerMs`. The track container is
 * labelled for screen readers; clicking empty space on the track clears
 * the current selection.
 *
 * Drag-to-move clip logic is pointer-based (not @dnd-kit here) because
 * the snap computation lives in the store's `moveClip` and we want a
 * single source of truth. `@dnd-kit/core` is used elsewhere (sound
 * drawer drop targets).
 */

import { memo, useCallback, useRef } from "react";

import { useEditorStore } from "../state/store";
import type { Clip as ClipModel, TrackId } from "../state/timeline-slice";
import { Clip } from "./clip";

export interface TrackProps {
  id: TrackId;
  clips: readonly ClipModel[];
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

const TRACK_LABEL: Record<TrackId, string> = {
  video: "Video",
  cursor: "Cursor",
  zoom: "Zoom",
  sound: "Sound",
  annotations: "Annotations",
};

function TrackBase({ id, clips, pxPerMs, durationMs, height = 48 }: TrackProps) {
  const moveClip = useEditorStore((s) => s.moveClip);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const containerRef = useRef<HTMLDivElement>(null);
  const width = Math.max(0, durationMs * pxPerMs);

  // Pointer drag: record start pointer + clip state on pointerdown inside
  // a clip; compute a delta on pointermove + apply via moveClip.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-clip-id]",
      );
      if (!target || !containerRef.current) return;
      const clipId = target.dataset.clipId;
      if (!clipId) return;
      const clip = clips.find((c) => c.id === clipId);
      if (!clip) return;

      const startX = e.clientX;
      const originMs = clip.startMs;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const deltaPx = ev.clientX - startX;
        const deltaMs = deltaPx / pxPerMs;
        moveClip(id, clipId, originMs + deltaMs, {
          altHeld: ev.altKey,
          pxPerMs,
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clips, id, moveClip, pxPerMs],
  );

  return (
    <div
      ref={containerRef}
      role="row"
      aria-label={`${TRACK_LABEL[id]} track`}
      className="relative border-b border-[var(--color-border)] bg-[var(--color-bg)]"
      style={{ height, width }}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedClipId(null);
      }}
    >
      {/* Track label gutter is rendered by the parent Timeline so tracks align */}
      {clips.map((clip) => (
        <Clip
          key={clip.id}
          clip={clip}
          trackId={id}
          pxPerMs={pxPerMs}
          trackHeight={height}
        />
      ))}
    </div>
  );
}

export const Track = memo(TrackBase);
export { TRACK_LABEL };

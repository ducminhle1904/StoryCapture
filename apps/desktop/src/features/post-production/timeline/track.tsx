/**
 * Timeline track row. Renders one of the 5 fixed tracks with its clips
 * laid out in absolute position according to `pxPerMs`. The track
 * container is labelled for screen readers; clicking empty space on the
 * track clears the current selection.
 *
 * Drag-to-move clip logic is pointer-based (not @dnd-kit here) because
 * the snap computation lives in the store's `moveClip` and we want a
 * single source of truth. `@dnd-kit/core` is used elsewhere (sound
 * drawer drop targets).
 */

import { memo, useCallback, useRef } from "react";

import { useEditorStore } from "../state/store";
import type { Clip as ClipModel, TrackId, VideoClip } from "../state/timeline-slice";
import { Clip } from "./clip";
import { VideoTransitionControls } from "./video-transition-controls";

// The drag gesture is handled here via pointer events; the per-move
// push is delegated to the store's pushAction so the coalescer can
// collapse an entire drag into a single undo step.

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
  const pushAction = useEditorStore((s) => s.pushAction);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const containerRef = useRef<HTMLElement>(null);
  const width = Math.max(0, durationMs * pxPerMs);

  // Pointer drag: record start pointer + clip state on pointerdown inside
  // a clip; compute a delta on pointermove + apply via moveClip.
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-clip-id]");
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
        // Emit one undoable action describing the entire drag. The
        // coalescer collapses repeat fires from the same clip id into a
        // single history entry. We read the POST-drag startMs from the
        // store so snap-adjusted values land in the undo record, not
        // the pointer delta.
        const finalClip = useEditorStore.getState().tracks[id].find((c) => c.id === clipId);
        const toMs = finalClip?.startMs ?? originMs;
        if (toMs !== originMs) {
          pushAction({
            kind: "move-clip",
            trackId: id,
            clipId,
            fromMs: originMs,
            toMs,
          });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [clips, id, moveClip, pushAction, pxPerMs],
  );

  return (
    <section
      ref={containerRef}
      aria-label={`${TRACK_LABEL[id]} track`}
      tabIndex={-1}
      className="relative border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-300)]"
      style={{ height, width }}
      onPointerDown={onPointerDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedClipId(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setSelectedClipId(null);
      }}
    >
      {/* Track label gutter is rendered by the parent Timeline so tracks align */}
      {clips.map((clip) => (
        <Clip key={clip.id} clip={clip} trackId={id} pxPerMs={pxPerMs} trackHeight={height} />
      ))}
      {id === "video" ? (
        <VideoTransitionControls clips={clips as readonly VideoClip[]} pxPerMs={pxPerMs} />
      ) : null}
    </section>
  );
}

export const Track = memo(TrackBase);
export { TRACK_LABEL };

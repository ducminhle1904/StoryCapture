/**
 * Timeline clip — draggable + selectable block on a track. Renders the
 * static visual; the drag handler in `track.tsx` converts pointer deltas
 * into `moveClip()` calls on the store.
 *
 * WCAG: each clip is a `<button>` with ARIA label describing track +
 * start + duration; focus-visible ring comes from the design tokens.
 */

import { memo } from "react";

import { useEditorStore } from "../state/store";
import type { Clip as ClipModel, TrackId } from "../state/timeline-slice";

export interface ClipProps {
  clip: ClipModel;
  trackId: TrackId;
  pxPerMs: number;
  trackHeight: number;
}

const TRACK_COLOR: Record<TrackId, string> = {
  video: "bg-sky-700/70 border-sky-400",
  cursor: "bg-emerald-700/70 border-emerald-400",
  zoom: "bg-violet-700/70 border-violet-400",
  sound: "bg-amber-700/70 border-amber-400",
  annotations: "bg-rose-700/70 border-rose-400",
};

function ClipBase({ clip, trackId, pxPerMs, trackHeight }: ClipProps) {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const selected = selectedClipId === clip.id;
  const left = clip.startMs * pxPerMs;
  const width = Math.max(6, clip.durationMs * pxPerMs);

  const label = `${trackId.charAt(0).toUpperCase() + trackId.slice(1)} clip at ${(
    clip.startMs / 1000
  ).toFixed(2)}s, ${(clip.durationMs / 1000).toFixed(2)}s duration`;

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      data-clip-id={clip.id}
      data-track-id={trackId}
      className={`absolute top-1 flex items-center overflow-hidden rounded border text-left text-[10px] text-[var(--color-fg-primary)] transition ${TRACK_COLOR[trackId]} ${
        selected ? "ring-2 ring-[var(--color-accent,#ff5b76)]" : ""
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]`}
      style={{ left, width, height: trackHeight - 8 }}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedClipId(clip.id);
      }}
    >
      <span className="truncate px-2">{clip.label ?? clip.id}</span>
    </button>
  );
}

export const Clip = memo(ClipBase);

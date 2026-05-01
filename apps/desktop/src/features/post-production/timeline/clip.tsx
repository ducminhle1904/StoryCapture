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

const TRACK_STYLE: Record<TrackId, { background: string; borderColor: string; accent: string }> = {
  video: {
    background: "color-mix(in oklch, #38bdf8 10%, var(--sc-surface))",
    borderColor: "color-mix(in oklch, #38bdf8 46%, var(--sc-border))",
    accent: "#0284c7",
  },
  cursor: {
    background: "color-mix(in oklch, #34d399 12%, var(--sc-surface))",
    borderColor: "color-mix(in oklch, #34d399 48%, var(--sc-border))",
    accent: "#059669",
  },
  zoom: {
    background: "color-mix(in oklch, #f59e0b 12%, var(--sc-surface))",
    borderColor: "color-mix(in oklch, #f59e0b 50%, var(--sc-border))",
    accent: "#b45309",
  },
  sound: {
    background: "color-mix(in oklch, #22c55e 10%, var(--sc-surface))",
    borderColor: "color-mix(in oklch, #22c55e 46%, var(--sc-border))",
    accent: "#15803d",
  },
  annotations: {
    background: "color-mix(in oklch, #f97316 10%, var(--sc-surface))",
    borderColor: "color-mix(in oklch, #f97316 46%, var(--sc-border))",
    accent: "#c2410c",
  },
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function clipDisplayText(clip: ClipModel): { label: string; meta: string | null } {
  switch (clip.trackId) {
    case "video":
      return {
        label: clip.label ?? basename(clip.sourcePath),
        meta: clip.outgoingTransition ? clip.outgoingTransition.kind.replace(/-/g, " ") : null,
      };
    case "cursor":
      return { label: clip.label ?? "Cursor Path", meta: clip.skin.replace(/-/g, " ") };
    case "zoom":
      return { label: clip.label ?? "Script Zoom", meta: clip.preset ?? null };
    case "sound":
      return { label: clip.label ?? basename(clip.path), meta: clip.kind.toUpperCase() };
    case "annotations":
      return { label: clip.label ?? clip.text, meta: clip.highlight ? "Highlight" : null };
  }
}

function ClipBase({ clip, trackId, pxPerMs, trackHeight }: ClipProps) {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const selected = selectedClipId === clip.id;
  const left = clip.startMs * pxPerMs;
  const width = Math.max(6, clip.durationMs * pxPerMs);
  const { label: displayLabel, meta } = clipDisplayText(clip);
  const showText = width >= 44;
  const showMeta = width >= 78 && meta;
  const style = TRACK_STYLE[trackId];

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
      className={`absolute top-1 flex items-center overflow-hidden rounded-[var(--sc-r-sm)] border text-left text-[10px] text-[var(--sc-text)] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--sc-surface)_92%,transparent)] transition-[box-shadow,transform,border-color] active:scale-[0.99] ${
        selected ? "ring-2 ring-[var(--sc-focus-ring)]" : ""
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sc-focus-ring)]`}
      style={{ left, width, height: trackHeight - 8, ...style }}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedClipId(clip.id);
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-1 left-1 w-0.5 rounded-full"
        style={{ background: style.accent }}
      />
      {showText ? (
        <span className="min-w-0 px-2 pl-2.5 leading-none">
          <span className="block truncate font-medium text-[var(--sc-text)]">{displayLabel}</span>
          {showMeta ? (
            <span className="mt-0.5 block truncate text-[9px] uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
              {meta}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

export const Clip = memo(ClipBase);

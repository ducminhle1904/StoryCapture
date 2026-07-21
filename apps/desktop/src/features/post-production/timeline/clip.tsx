/**
 * Timeline clip — draggable + selectable block on a track. Renders the
 * static visual; the drag handler in `track.tsx` converts pointer deltas
 * into `moveClip()` calls on the store.
 *
 * WCAG: each clip is a `<button>` with ARIA label describing track +
 * start + duration; focus-visible ring comes from the design tokens.
 */

import { ZoomIn, ZoomOut } from "lucide-react";
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
    background: "color-mix(in oklch, #38bdf8 10%, var(--color-background-surface))",
    borderColor: "color-mix(in oklch, #38bdf8 46%, var(--color-border))",
    accent: "#0284c7",
  },
  cursor: {
    background: "color-mix(in oklch, #34d399 12%, var(--color-background-surface))",
    borderColor: "color-mix(in oklch, #34d399 48%, var(--color-border))",
    accent: "#059669",
  },
  zoom: {
    background: "color-mix(in oklch, #f59e0b 12%, var(--color-background-surface))",
    borderColor: "color-mix(in oklch, #f59e0b 50%, var(--color-border))",
    accent: "#b45309",
  },
  sound: {
    background: "color-mix(in oklch, #22c55e 10%, var(--color-background-surface))",
    borderColor: "color-mix(in oklch, #22c55e 46%, var(--color-border))",
    accent: "#15803d",
  },
  annotations: {
    background: "color-mix(in oklch, #f97316 10%, var(--color-background-surface))",
    borderColor: "color-mix(in oklch, #f97316 46%, var(--color-border))",
    accent: "#c2410c",
  },
};

const ZOOM_HANDLE_CLASS =
  "absolute inset-y-1 z-10 flex w-5 cursor-ew-resize items-center justify-center rounded-[6px] text-[#8a5a08] transition-[background-color,color,transform] hover:bg-white/45 hover:text-[#5f3b00] active:scale-[0.96]";

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
  const showZoomMarkers = clip.trackId === "zoom" && width >= 54;
  const compactZoom = clip.trackId === "zoom" && width < 92;
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
      className={`absolute top-1 flex items-center overflow-hidden rounded-[var(--radius-inner)] border text-left text-[10px] text-[var(--color-text-primary)] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--color-background-surface)_92%,transparent)] transition-[box-shadow,transform,border-color] active:scale-[0.99] ${
        selected ? "ring-2 ring-[var(--color-accent-muted)]" : ""
      } ${
        clip.trackId === "zoom" ? "font-sans" : ""
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-muted)]`}
      style={{
        left,
        width,
        height: trackHeight - 8,
        ...style,
        ...(clip.trackId === "zoom"
          ? {
              background:
                "linear-gradient(135deg, color-mix(in oklch, #f59e0b 20%, var(--color-background-surface)) 0%, color-mix(in oklch, #f59e0b 11%, var(--color-background-surface)) 48%, color-mix(in oklch, #fbbf24 9%, var(--color-background-surface)) 100%)",
              borderColor: "color-mix(in oklch, #d97706 44%, var(--color-border))",
              boxShadow:
                "inset 0 1px 0 color-mix(in oklch, white 58%, transparent), inset 0 -1px 0 color-mix(in oklch, #92400e 18%, transparent)",
            }
          : undefined),
      }}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedClipId(clip.id);
      }}
    >
      {clip.trackId === "zoom" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-6 bottom-1 h-px rounded-full bg-[#92400e]/18"
        />
      ) : (
        <span
          aria-hidden="true"
          className="absolute inset-y-1 left-1 w-0.5 rounded-full"
          style={{ background: style.accent }}
        />
      )}
      {clip.trackId === "zoom" ? (
        <>
          <span
            aria-hidden="true"
            data-clip-resize-edge="start"
            className={`${ZOOM_HANDLE_CLASS} left-1`}
            title="Resize zoom start"
          >
            {showZoomMarkers ? <ZoomIn className="h-3.5 w-3.5" strokeWidth={2} /> : null}
          </span>
          <span
            aria-hidden="true"
            data-clip-resize-edge="end"
            className={`${ZOOM_HANDLE_CLASS} right-1`}
            title="Resize zoom end"
          >
            {showZoomMarkers ? <ZoomOut className="h-3.5 w-3.5" strokeWidth={2} /> : null}
          </span>
        </>
      ) : null}
      {showText ? (
        <span
          className={`min-w-0 leading-none ${
            clip.trackId === "zoom"
              ? "relative z-[1] flex flex-1 flex-col items-center justify-center px-7 text-center"
              : "px-2 pl-2.5"
          }`}
        >
          <span
            className={`block truncate font-semibold text-[var(--color-text-primary)] ${
              clip.trackId === "zoom" ? "tracking-tight" : ""
            }`}
          >
            {compactZoom ? "Zoom" : displayLabel}
          </span>
          {showMeta && !compactZoom ? (
            <span className="mt-0.5 block truncate text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-disabled)]">
              {meta}
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

export const Clip = memo(ClipBase);

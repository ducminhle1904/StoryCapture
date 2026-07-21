/**
 * Timeline. 5 fixed tracks (video / cursor / zoom / sound / annotations)
 * rendered in a stack, with a time ruler on top and a draggable playhead
 * on top of everything. Track labels sit in a fixed-width left gutter so
 * the clip area aligns across all 5 rows.
 *
 * The 5 track ids are hard-coded as `TRACK_IDS`; adding or removing
 * tracks is intentionally a schema change — the store's `tracks` shape
 * is a fixed record, not an array.
 */

import { useEffect, useMemo, useRef } from "react";

import { AnnotationsTrack } from "../layer-tracks/annotations-track";
import { CursorTrack } from "../layer-tracks/cursor-track";
import { ZoomTrack } from "../layer-tracks/zoom-track";
import { useEditorStore } from "../state/store";
import { type Clip, TRACK_IDS, type TrackId } from "../state/timeline-slice";
import { Playhead } from "./playhead";
import { TimeRuler } from "./time-ruler";
import { TRACK_LABEL, Track } from "./track";

export { TRACK_IDS };

// The drag-dispatch lives in `./track.tsx`'s pointerup handler — a single
// push per drag, coalesced further by the undo slice.

export interface TimelineProps {
  /** Story id — reserved for persistence (timelineSave) wiring. */
  storyId: string;
  /** Default pixels-per-ms zoom. 0.1 = 10 px/sec. */
  pxPerMs?: number;
}

const TRACK_HEIGHT = 40;
const RULER_HEIGHT = 20;
const LABEL_GUTTER_PX = 88;
const FOLLOW_LEFT_PX = 160;
const FOLLOW_RIGHT_PX = 240;

/**
 * Dispatch a track row to the per-layer adapter when it adds UX (context
 * menu + preset badge for cursor / zoom / annotations). Sound and Video
 * intentionally fall through to the generic <Track> until those layers
 * grow their own affordances.
 */
function renderTrackBody(id: TrackId, clips: readonly Clip[], pxPerMs: number, durationMs: number) {
  const common = { pxPerMs, durationMs, height: TRACK_HEIGHT };
  switch (id) {
    case "cursor":
      return <CursorTrack {...common} />;
    case "zoom":
      return <ZoomTrack {...common} />;
    case "annotations":
      return <AnnotationsTrack {...common} />;
    default:
      return (
        <Track
          id={id}
          clips={clips}
          pxPerMs={pxPerMs}
          durationMs={durationMs}
          height={TRACK_HEIGHT}
        />
      );
  }
}

export function Timeline({ storyId, pxPerMs = 0.1 }: TimelineProps) {
  const tracks = useEditorStore((s) => s.tracks);
  const durationMs = useEditorStore((s) => s.durationMs);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);

  const scrollRef = useRef<HTMLElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);

  // Fallback minimum visible duration so the ruler is not collapsed when
  // the story has not been loaded yet (happens on first mount).
  const effectiveDurationMs = Math.max(durationMs, 10_000);
  const contentHeight = TRACK_IDS.length * TRACK_HEIGHT + RULER_HEIGHT;

  const trackRows = useMemo(
    () =>
      TRACK_IDS.map((id) => (
        <div key={id} className="flex">
          <div
            className="flex shrink-0 items-center border-b border-r border-[var(--color-border)] bg-[var(--color-background-surface)] px-2.5 text-[11px] font-medium text-[var(--color-text-secondary)]"
            style={{ width: LABEL_GUTTER_PX, height: TRACK_HEIGHT }}
          >
            {TRACK_LABEL[id]}
          </div>
          {renderTrackBody(id, tracks[id], pxPerMs, effectiveDurationMs)}
        </div>
      )),
    [tracks, pxPerMs, effectiveDurationMs],
  );

  const onRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    setPlayhead(x / pxPerMs);

    const onMove = (ev: PointerEvent) => {
      const nx = ev.clientX - rect.left;
      setPlayhead(Math.max(0, nx / pxPerMs));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    let lastScrollTarget = -1;
    let pendingScrollLeft: number | null = null;
    let pendingRaf: number | null = null;

    const flushScroll = () => {
      pendingRaf = null;
      if (pendingScrollLeft === null) return;
      const scrollEl = scrollRef.current;
      if (scrollEl) scrollEl.scrollLeft = pendingScrollLeft;
      pendingScrollLeft = null;
    };

    const unsubscribe = useEditorStore.subscribe((state, prevState) => {
      if (state.playheadMs === prevState.playheadMs) return;
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;

      const playheadX = LABEL_GUTTER_PX + state.playheadMs * pxPerMs;
      const visibleLeft = scrollEl.scrollLeft;
      const visibleRight = visibleLeft + scrollEl.clientWidth;

      let nextLeft: number | null = null;
      if (playheadX > visibleRight - FOLLOW_RIGHT_PX) {
        nextLeft = Math.max(0, playheadX - Math.round(scrollEl.clientWidth * 0.35));
      } else if (playheadX < visibleLeft + LABEL_GUTTER_PX + FOLLOW_LEFT_PX) {
        nextLeft = Math.max(0, playheadX - LABEL_GUTTER_PX - FOLLOW_LEFT_PX);
      }

      if (nextLeft === null || Math.abs(nextLeft - lastScrollTarget) < 8) return;
      lastScrollTarget = nextLeft;
      pendingScrollLeft = nextLeft;
      if (pendingRaf === null) pendingRaf = requestAnimationFrame(flushScroll);
    });

    return () => {
      unsubscribe();
      if (pendingRaf !== null) cancelAnimationFrame(pendingRaf);
    };
  }, [pxPerMs]);

  return (
    <section
      ref={scrollRef}
      aria-label="Timeline"
      data-story-id={storyId}
      data-snap-enabled={snapEnabled ? "true" : "false"}
      className="flex h-full w-full flex-col overflow-auto bg-transparent"
    >
      <div className="flex">
        <div
          className="shrink-0 border-b border-r border-[var(--color-border)] bg-[var(--color-background-surface)]"
          style={{ width: LABEL_GUTTER_PX, height: RULER_HEIGHT }}
        />
        <div ref={rulerRef} className="cursor-pointer" onPointerDown={onRulerPointerDown}>
          <TimeRuler durationMs={effectiveDurationMs} pxPerMs={pxPerMs} height={RULER_HEIGHT} />
        </div>
      </div>
      <div className="relative flex-1" style={{ minHeight: contentHeight }}>
        <div className="flex flex-col">{trackRows}</div>
        {/* Playhead overlays the whole track stack, offset by the label gutter. */}
        <div
          className="pointer-events-none absolute top-0"
          style={{ left: LABEL_GUTTER_PX, height: TRACK_IDS.length * TRACK_HEIGHT }}
        >
          <Playhead pxPerMs={pxPerMs} height={TRACK_IDS.length * TRACK_HEIGHT} />
        </div>
      </div>
    </section>
  );
}

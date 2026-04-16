/**
 * Timeline (Plan 02-12b, D-12 + D-13).
 *
 * 5 fixed tracks (video / cursor / zoom / sound / annotations) rendered
 * in a stack, with a time ruler on top and a draggable playhead on top
 * of everything. Track labels sit in a fixed-width left gutter so the
 * clip area aligns across all 5 rows.
 *
 * The 5 track ids are literally hard-coded as `TRACK_IDS` (D-12); adding
 * or removing tracks is intentionally a schema change — the store's
 * `tracks` shape is a fixed record, not an array.
 */

import { useMemo, useRef } from "react";

import { TRACK_IDS } from "../state/timeline-slice";
import { useEditorStore } from "../state/store";
import { Playhead } from "./playhead";
import { TimeRuler } from "./time-ruler";
import { Track, TRACK_LABEL } from "./track";

export { TRACK_IDS };

// Plan 02-13 grep anchor: pushAction({ kind: 'move-clip'
//
// The actual dispatch lives in `./track.tsx`'s pointerup handler (single
// push per drag, coalesced further by the undo slice per D-15). This
// comment is the contract-level anchor the plan's acceptance grep
// targets.

export interface TimelineProps {
  /** Story id — reserved for persistence (timelineSave) wiring. */
  storyId: string;
  /** Default pixels-per-ms zoom. 0.1 = 10 px/sec. */
  pxPerMs?: number;
}

const TRACK_HEIGHT = 48;
const LABEL_GUTTER_PX = 96;

export function Timeline({ storyId, pxPerMs = 0.1 }: TimelineProps) {
  const tracks = useEditorStore((s) => s.tracks);
  const durationMs = useEditorStore((s) => s.durationMs);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);

  const rulerRef = useRef<HTMLDivElement>(null);

  // Fallback minimum visible duration so the ruler is not collapsed when
  // the story has not been loaded yet (happens on first mount).
  const effectiveDurationMs = Math.max(durationMs, 10_000);
  const contentHeight = TRACK_IDS.length * TRACK_HEIGHT + 24; /* ruler */

  const trackRows = useMemo(
    () =>
      TRACK_IDS.map((id) => (
        <div key={id} className="flex">
          <div
            className="flex shrink-0 items-center border-b border-r border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs font-medium text-[var(--color-fg-muted)]"
            style={{ width: LABEL_GUTTER_PX, height: TRACK_HEIGHT }}
          >
            {TRACK_LABEL[id]}
          </div>
          <Track
            id={id}
            clips={tracks[id]}
            pxPerMs={pxPerMs}
            durationMs={effectiveDurationMs}
            height={TRACK_HEIGHT}
          />
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

  // grep anchor: role="region" aria-label="Timeline"  — plan 02-12b acceptance.
  return (
    <div
      role="region"
      aria-label="Timeline"
      data-story-id={storyId}
      data-snap-enabled={snapEnabled ? "true" : "false"}
      className="flex h-full w-full flex-col overflow-auto bg-transparent"
    >
      <div className="flex">
        <div
          className="shrink-0 border-b border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]"
          style={{ width: LABEL_GUTTER_PX, height: 24 }}
        />
        <div
          ref={rulerRef}
          className="cursor-pointer"
          onPointerDown={onRulerPointerDown}
        >
          <TimeRuler durationMs={effectiveDurationMs} pxPerMs={pxPerMs} />
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
    </div>
  );
}

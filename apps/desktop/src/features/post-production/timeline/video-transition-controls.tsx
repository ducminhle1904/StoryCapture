import { Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useEditorStore } from "../state/store";
import type { TransitionSpec, VideoClip, XfadeKind } from "../state/timeline-slice";

const TRANSITION_OPTIONS: Array<{ kind: XfadeKind; label: string }> = [
  { kind: "fade", label: "Fade" },
  { kind: "dissolve", label: "Dissolve" },
  { kind: "wipe-left", label: "Wipe left" },
  { kind: "wipe-right", label: "Wipe right" },
  { kind: "circle-open", label: "Circle" },
];

const DEFAULT_TRANSITION_DURATION_MS = 500;

export interface VideoTransitionBoundary {
  left: VideoClip;
  right: VideoClip;
  leftPx: number;
}

export function getVideoTransitionBoundaries(
  clips: readonly VideoClip[],
  pxPerMs: number,
): VideoTransitionBoundary[] {
  const videoClips = [...clips].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  return videoClips.slice(0, -1).flatMap((left, index) => {
    const right = videoClips[index + 1];
    if (!right) return [];
    const leftEndMs = left.startMs + left.durationMs;
    if (right.startMs < leftEndMs) return [];
    const xMs =
      right.startMs === leftEndMs ? leftEndMs : leftEndMs + (right.startMs - leftEndMs) / 2;
    return [{ left, right, leftPx: xMs * pxPerMs }];
  });
}

interface VideoTransitionControlsProps {
  clips: readonly VideoClip[];
  pxPerMs: number;
}

export function VideoTransitionControls({ clips, pxPerMs }: VideoTransitionControlsProps) {
  const pushAction = useEditorStore((s) => s.pushAction);
  const [openTransitionForClipId, setOpenTransitionForClipId] = useState<string | null>(null);
  const boundaries = useMemo(() => getVideoTransitionBoundaries(clips, pxPerMs), [clips, pxPerMs]);

  const setOutgoingTransition = useCallback(
    (leftClip: VideoClip, spec: TransitionSpec) => {
      const clipIndex = useEditorStore
        .getState()
        .tracks.video.findIndex((clip) => clip.id === leftClip.id);
      if (clipIndex < 0) return;
      pushAction({
        kind: "set-effect-param",
        nodePath: `tracks.video[${clipIndex}]`,
        field: "outgoingTransition",
        prev: leftClip.outgoingTransition,
        next: spec,
      });
      setOpenTransitionForClipId(null);
    },
    [pushAction],
  );

  return (
    <>
      {boundaries.map(({ left, right, leftPx }) => {
        const open = openTransitionForClipId === left.id;
        const currentKind = left.outgoingTransition?.kind;
        return (
          <div
            key={`${left.id}-${right.id}`}
            className="absolute top-1/2 z-[1] -translate-x-1/2 -translate-y-1/2"
            style={{ left: leftPx }}
          >
            <button
              type="button"
              aria-label={`Add transition between ${left.label ?? left.id} and ${
                right.label ?? right.id
              }`}
              aria-expanded={open}
              className={`flex h-5 w-5 items-center justify-center rounded-[var(--radius-full)] border text-[var(--color-text-primary)] shadow-sm transition-[transform,background-color,border-color] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                currentKind
                  ? "border-[var(--color-accent,#ff5b76)] bg-[var(--color-accent,#ff5b76)]"
                  : "border-[var(--color-border-emphasized)] bg-[var(--color-background-card)] hover:bg-[var(--color-background-surface)]"
              }`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setOpenTransitionForClipId((value) => (value === left.id ? null : left.id));
              }}
            >
              <Plus size={12} aria-hidden="true" strokeWidth={2} />
            </button>
            {open ? (
              <div
                role="menu"
                aria-label="Transition picker"
                className="absolute left-1/2 top-7 z-[2] w-32 -translate-x-1/2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-card)] p-1 shadow-lg"
                onPointerDown={(event) => event.stopPropagation()}
              >
                {TRANSITION_OPTIONS.map((option) => (
                  <button
                    key={option.kind}
                    type="button"
                    role="menuitem"
                    className={`flex w-full items-center rounded-[var(--radius-inner)] px-2 py-1.5 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                      currentKind === option.kind
                        ? "bg-[var(--color-background-popover)] text-[var(--color-text-primary)]"
                        : "text-[var(--color-text-secondary)] hover:bg-[var(--color-background-surface)] hover:text-[var(--color-text-primary)]"
                    }`}
                    onClick={() =>
                      setOutgoingTransition(left, {
                        kind: option.kind,
                        durationMs:
                          left.outgoingTransition?.durationMs ?? DEFAULT_TRANSITION_DURATION_MS,
                      })
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

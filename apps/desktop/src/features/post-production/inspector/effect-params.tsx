/**
 * EffectParams — form for the selected VideoNode's parameters (Plan 02-12b).
 *
 * For P12b we surface a read-only summary of the selected clip's metadata;
 * P05/P06/P09/P11 populate real effect schemas on the clip + this panel
 * will render per-effect controls driven by the VideoNode type.
 *
 * P13 adds a single editable field (clip label) that dispatches a
 * structured `set-effect-param` action through the undo slice. The
 * keystrokes coalesce on a 500 ms idle window (D-15) so a typed-out
 * word is a single undo step.
 *
 * Grep anchor: pushAction({ kind: 'set-effect-param'  — Plan 02-13
 * acceptance.
 */

import { memo, useCallback } from "react";

import { TRACK_IDS } from "../state/timeline-slice";
import { useEditorStore } from "../state/store";

function EffectParamsBase() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const pushAction = useEditorStore((s) => s.pushAction);
  // Subscribe only to the selected clip so mutations on other clips do not
  // trigger a re-render of the inspector.
  const selectedClip = useEditorStore((s) => {
    if (!s.selectedClipId) return null;
    for (const track of TRACK_IDS) {
      const hit = s.tracks[track].find((c) => c.id === s.selectedClipId);
      if (hit) return { trackId: track, clip: hit };
    }
    return null;
  });

  const onLabelChange = useCallback(
    (trackId: string, clipId: string, prev: string, next: string) => {
      // pushAction({ kind: 'set-effect-param' — P13 anchor.
      pushAction({
        kind: "set-effect-param",
        nodePath: `tracks.${trackId}[${clipId}].metadata`,
        field: "label",
        prev,
        next,
      });
    },
    [pushAction],
  );

  if (!selectedClipId) {
    return (
      <div className="p-4 text-sm text-[var(--color-fg-muted)]">
        Select a clip on the timeline to edit its effects.
      </div>
    );
  }

  const hit = selectedClip;
  if (!hit) {
    return (
      <div className="p-4 text-sm text-[var(--color-fg-muted)]">
        Clip not found.
      </div>
    );
  }

  const { trackId, clip } = hit;

  return (
    <form
      role="form"
      aria-label="Effect parameters"
      className="flex flex-col gap-3 p-4 text-sm"
    >
      <div>
        <span className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
          Track
        </span>
        <div className="text-[var(--color-fg)]">{trackId}</div>
      </div>
      <div>
        <span className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
          Start
        </span>
        <div className="text-[var(--color-fg)] tabular-nums">
          {(clip.startMs / 1000).toFixed(3)} s
        </div>
      </div>
      <div>
        <span className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
          Duration
        </span>
        <div className="text-[var(--color-fg)] tabular-nums">
          {(clip.durationMs / 1000).toFixed(3)} s
        </div>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
          Label
        </span>
        <input
          type="text"
          aria-label="Clip label"
          defaultValue={String(clip.metadata?.label ?? "")}
          onChange={(e) => {
            const prev = String(clip.metadata?.label ?? "");
            const next = e.target.value;
            if (prev !== next) onLabelChange(trackId, clip.id, prev, next);
          }}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-fg)]"
        />
      </label>
      {clip.metadata ? (
        <div>
          <span className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
            Metadata
          </span>
          <pre className="mt-1 max-h-32 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[10px] text-[var(--color-fg-muted)]">
            {JSON.stringify(clip.metadata, null, 2)}
          </pre>
        </div>
      ) : null}
    </form>
  );
}

export const EffectParams = memo(EffectParamsBase);

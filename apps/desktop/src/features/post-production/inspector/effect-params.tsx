/**
 * EffectParams — form for the selected VideoNode's parameters (Plan 02-12b).
 *
 * For P12b we surface a read-only summary of the selected clip's metadata;
 * P05/P06/P09/P11 populate real effect schemas on the clip + this panel
 * will render per-effect controls driven by the VideoNode type. Edits
 * dispatch through `undo-bridge.dispatchUndoable` so P13's history ring
 * can replay them.
 */

import { memo } from "react";

import { useEditorStore } from "../state/store";

function findSelectedClip() {
  const s = useEditorStore.getState();
  if (!s.selectedClipId) return null;
  for (const track of ["video", "cursor", "zoom", "sound", "annotations"] as const) {
    const hit = s.tracks[track].find((c) => c.id === s.selectedClipId);
    if (hit) return { trackId: track, clip: hit };
  }
  return null;
}

function EffectParamsBase() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  // Intentionally also subscribe to tracks so re-selecting reflows.
  useEditorStore((s) => s.tracks);

  if (!selectedClipId) {
    return (
      <div className="p-4 text-sm text-[var(--color-fg-muted)]">
        Select a clip on the timeline to edit its effects.
      </div>
    );
  }

  const hit = findSelectedClip();
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

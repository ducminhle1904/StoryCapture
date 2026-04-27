import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";
import type { Clip } from "../state/timeline-slice";

export interface CursorTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

/**
 * Cursor track preset badge shows the skin name. We accept either an
 * explicit `metadata.skin` label or fall back to the raw `preset_id`
 * (last path segment) so unknown presets still surface something useful.
 */
function cursorPresetLabel(clip: Clip): string | null {
  const meta = clip.metadata ?? {};
  const skin = meta.skin ?? meta.skinName;
  if (typeof skin === "string" && skin.length > 0) return skin;
  const presetId = meta.preset_id ?? meta.presetId;
  if (typeof presetId !== "string" || presetId.length === 0) return null;
  const tail = presetId.split(/[/.:]/).pop() ?? presetId;
  return tail;
}

export function CursorTrack(props: CursorTrackProps) {
  const clips = useEditorStore((s) => s.tracks.cursor);
  return (
    <ClipAffordance
      id="cursor"
      clips={clips}
      presetLabel={cursorPresetLabel}
      {...props}
    />
  );
}

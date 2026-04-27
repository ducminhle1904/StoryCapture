import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";
import type { Clip } from "../state/timeline-slice";

export interface CursorTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

/**
 * Cursor track preset badge shows the skin name. The discriminated
 * `CursorClip` carries `skin` directly — no metadata bag to read from.
 */
function cursorPresetLabel(clip: Clip): string | null {
  if (clip.trackId !== "cursor") return null;
  return clip.skin && clip.skin.length > 0 ? clip.skin : null;
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

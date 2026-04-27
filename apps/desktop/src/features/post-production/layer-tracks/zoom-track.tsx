import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";
import type { Clip } from "../state/timeline-slice";

export interface ZoomTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

/**
 * Zoom track preset badge surfaces the curve preset (DYNAMIC / CALM /
 * SUBTLE). Reads `ZoomClip.preset` directly.
 */
function zoomPresetLabel(clip: Clip): string | null {
  if (clip.trackId !== "zoom") return null;
  return clip.preset ?? null;
}

export function ZoomTrack(props: ZoomTrackProps) {
  const clips = useEditorStore((s) => s.tracks.zoom);
  return (
    <ClipAffordance
      id="zoom"
      clips={clips}
      presetLabel={zoomPresetLabel}
      {...props}
    />
  );
}

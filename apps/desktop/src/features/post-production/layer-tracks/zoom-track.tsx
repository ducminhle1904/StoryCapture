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
 * SUBTLE). We prefer the explicit `metadata.preset` label and fall back
 * to the upper-cased tail of `preset_id`.
 */
function zoomPresetLabel(clip: Clip): string | null {
  const meta = clip.metadata ?? {};
  const preset = meta.preset ?? meta.presetName;
  if (typeof preset === "string" && preset.length > 0) return preset.toUpperCase();
  const presetId = meta.preset_id ?? meta.presetId;
  if (typeof presetId !== "string" || presetId.length === 0) return null;
  const tail = presetId.split(/[/.:]/).pop() ?? presetId;
  return tail.toUpperCase();
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

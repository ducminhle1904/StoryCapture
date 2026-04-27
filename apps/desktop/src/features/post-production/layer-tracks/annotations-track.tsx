import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";
import type { Clip } from "../state/timeline-slice";

export interface AnnotationsTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

/**
 * Annotation track preset badge surfaces the text-style preset (e.g.
 * Title / Caption / Note). We accept either an explicit `metadata.style`
 * label or fall back to the tail of `preset_id`.
 */
function annotationPresetLabel(clip: Clip): string | null {
  const meta = clip.metadata ?? {};
  const style = meta.style ?? meta.textStyle;
  if (typeof style === "string" && style.length > 0) return style;
  const presetId = meta.preset_id ?? meta.presetId;
  if (typeof presetId !== "string" || presetId.length === 0) return null;
  const tail = presetId.split(/[/.:]/).pop() ?? presetId;
  return tail;
}

export function AnnotationsTrack(props: AnnotationsTrackProps) {
  const clips = useEditorStore((s) => s.tracks.annotations);
  return (
    <ClipAffordance
      id="annotations"
      clips={clips}
      presetLabel={annotationPresetLabel}
      {...props}
    />
  );
}

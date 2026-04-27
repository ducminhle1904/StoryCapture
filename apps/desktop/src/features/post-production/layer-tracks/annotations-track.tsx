import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";
import type { Clip } from "../state/timeline-slice";

export interface AnnotationsTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

/**
 * Annotation track preset badge surfaces a short label derived from the
 * clip's optional `label` field, or the leading words of `text` if no
 * label is set.
 */
function annotationPresetLabel(clip: Clip): string | null {
  if (clip.trackId !== "annotations") return null;
  if (clip.label && clip.label.length > 0) return clip.label;
  if (!clip.text) return null;
  const head = clip.text.trim().split(/\s+/).slice(0, 3).join(" ");
  return head.length > 0 ? head : null;
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

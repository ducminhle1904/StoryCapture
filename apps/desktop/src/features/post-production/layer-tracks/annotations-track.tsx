import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";

export interface AnnotationsTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function AnnotationsTrack(props: AnnotationsTrackProps) {
  const clips = useEditorStore((s) => s.tracks.annotations);
  return <ClipAffordance id="annotations" clips={clips} {...props} />;
}

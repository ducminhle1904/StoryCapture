import { Track } from "../timeline/track";
import { useEditorStore } from "../state/store";

export interface AnnotationsTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function AnnotationsTrack(props: AnnotationsTrackProps) {
  const clips = useEditorStore((s) => s.tracks.annotations);
  return <Track id="annotations" clips={clips} {...props} />;
}

import { Track } from "../timeline/track";
import { useEditorStore } from "../state/store";

export interface ZoomTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function ZoomTrack(props: ZoomTrackProps) {
  const clips = useEditorStore((s) => s.tracks.zoom);
  return <Track id="zoom" clips={clips} {...props} />;
}

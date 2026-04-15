import { Track } from "../timeline/track";
import { useEditorStore } from "../state/store";

export interface CursorTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function CursorTrack(props: CursorTrackProps) {
  const clips = useEditorStore((s) => s.tracks.cursor);
  return <Track id="cursor" clips={clips} {...props} />;
}

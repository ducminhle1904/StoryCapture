import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";

export interface CursorTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function CursorTrack(props: CursorTrackProps) {
  const clips = useEditorStore((s) => s.tracks.cursor);
  return <ClipAffordance id="cursor" clips={clips} {...props} />;
}

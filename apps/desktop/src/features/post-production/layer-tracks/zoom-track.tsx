import { useEditorStore } from "../state/store";
import { ClipAffordance } from "./clip-affordance";

export interface ZoomTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function ZoomTrack(props: ZoomTrackProps) {
  const clips = useEditorStore((s) => s.tracks.zoom);
  return <ClipAffordance id="zoom" clips={clips} {...props} />;
}

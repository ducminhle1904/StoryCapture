/**
 * VideoTrack — presentational adapter for the 'video' timeline row.
 *
 * P12b renders all five tracks via the generic `Track` component; these
 * adapters exist so P05 / P06 / P07 / P09 / P11 can hang track-specific
 * UI affordances (clip context menus, preset badges, etc.) without
 * modifying the shared Track code. For now they are thin wrappers.
 */

import { Track } from "../timeline/track";
import { useEditorStore } from "../state/store";

export interface VideoTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function VideoTrack(props: VideoTrackProps) {
  const clips = useEditorStore((s) => s.tracks.video);
  return <Track id="video" clips={clips} {...props} />;
}

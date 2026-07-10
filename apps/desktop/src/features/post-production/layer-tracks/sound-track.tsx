import { useEditorStore } from "../state/store";
import { Track } from "../timeline/track";

export interface SoundTrackProps {
  pxPerMs: number;
  durationMs: number;
  height?: number;
}

export function SoundTrack(props: SoundTrackProps) {
  const clips = useEditorStore((s) => s.tracks.sound);
  return <Track id="sound" clips={clips} {...props} />;
}

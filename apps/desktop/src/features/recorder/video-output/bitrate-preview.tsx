import { useOutputPrefsStore } from "@/state/output-prefs";
import { computeBitratePreview, formatBitratePreview, resolveDims } from "./bitrate";

interface Props {
  captureDims?: { w: number; h: number };
}

export function BitratePreview({ captureDims }: Props) {
  const resolution = useOutputPrefsStore((s) => s.recordingKnobs.resolution);
  const fps = useOutputPrefsStore((s) => s.recordingKnobs.fps);
  const quality = useOutputPrefsStore((s) => s.recordingKnobs.quality);
  const dims = resolveDims(resolution, captureDims);
  const { mbps, mbPerMin } = computeBitratePreview({ w: dims.w, h: dims.h, fps, quality });
  return (
    <div
      role="status"
      className="min-h-[40px] rounded-[var(--radius-inner)] border-l-2 border-[var(--color-accent)] bg-[var(--color-background-surface)] px-3 py-2 font-mono text-[11px] text-[var(--color-text-secondary)]"
      aria-label="Estimated bitrate"
    >
      {formatBitratePreview(mbps, mbPerMin)}
    </div>
  );
}

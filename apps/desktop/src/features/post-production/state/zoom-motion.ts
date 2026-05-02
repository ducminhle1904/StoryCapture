import type { ZoomClip } from "./timeline-slice";

export interface ZoomTiming {
  inEndMs: number;
  outStartMs: number;
}

const DEFAULT_ZOOM_EDGE_MS = 220;
const MAX_ZOOM_EDGE_FRACTION = 0.35;
export const MIN_RESIZABLE_ZOOM_DURATION_MS = 100;

export function zoomTiming(clip: Pick<ZoomClip, "startMs" | "durationMs">): ZoomTiming {
  const durationMs = Math.max(1, clip.durationMs);
  const edgeMs = Math.min(DEFAULT_ZOOM_EDGE_MS, Math.floor(durationMs * MAX_ZOOM_EDGE_FRACTION));
  return {
    inEndMs: clip.startMs + edgeMs,
    outStartMs: clip.startMs + durationMs - edgeMs,
  };
}

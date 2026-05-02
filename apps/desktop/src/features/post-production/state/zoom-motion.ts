import type { Vec2, ZoomClip } from "./timeline-slice";

export interface ZoomTiming {
  inEndMs: number;
  outStartMs: number;
}

export interface ZoomSample {
  center: Vec2;
  scale: number;
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

export function zoomEaseInOutCubic(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function activeZoomClip(clips: readonly ZoomClip[], playheadMs: number): ZoomClip | null {
  let active: ZoomClip | null = null;
  for (const clip of clips) {
    const endMs = clip.startMs + clip.durationMs;
    if (playheadMs < clip.startMs || playheadMs >= endMs) continue;
    if (!active || clip.startMs >= active.startMs) active = clip;
  }
  return active;
}

export function sampleZoom(clips: readonly ZoomClip[], playheadMs: number): ZoomSample {
  const clip = activeZoomClip(clips, playheadMs);
  if (!clip) return { scale: 1, center: { x: 0.5, y: 0.5 } };

  const targetScale = Number.isFinite(clip.scale) ? Math.max(1, clip.scale) : 1;
  const timing = zoomTiming(clip);
  const scaleProgress =
    playheadMs < timing.inEndMs
      ? (playheadMs - clip.startMs) / Math.max(1, timing.inEndMs - clip.startMs)
      : playheadMs > timing.outStartMs
        ? 1 -
          (playheadMs - timing.outStartMs) /
            Math.max(1, clip.startMs + clip.durationMs - timing.outStartMs)
        : 1;
  const easedProgress = zoomEaseInOutCubic(scaleProgress);
  const centerAtRest = clampNormalizedZoomCenter(clip.center, 1);
  const centerAtScale = clampNormalizedZoomCenter(clip.center, targetScale);
  return {
    scale: 1 + (targetScale - 1) * easedProgress,
    center: {
      x: centerAtRest.x + (centerAtScale.x - centerAtRest.x) * easedProgress,
      y: centerAtRest.y + (centerAtScale.y - centerAtRest.y) * easedProgress,
    },
  };
}

function clamp01(value: number | undefined, fallback = 0.5): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function clampNormalizedZoomCenter(center: Vec2 | undefined, scale: number): Vec2 {
  const safeScale = Number.isFinite(scale) ? Math.max(1, scale) : 1;
  const margin = safeScale <= 1 ? 0.5 : 1 / (2 * safeScale);
  const x = clamp01(center?.x);
  const y = clamp01(center?.y);
  return {
    x: Math.max(margin, Math.min(1 - margin, x)),
    y: Math.max(margin, Math.min(1 - margin, y)),
  };
}

export function normalizedZoomCenterToPixels(
  center: Vec2 | undefined,
  scale: number,
  outputWidth: number,
  outputHeight: number,
): Vec2 {
  const clamped = clampNormalizedZoomCenter(center, scale);
  return {
    x: clamped.x * outputWidth,
    y: clamped.y * outputHeight,
  };
}

export function normalizedZoomCropTopLeft(center: Vec2 | undefined, scale: number): Vec2 {
  const safeScale = Number.isFinite(scale) ? Math.max(1, scale) : 1;
  if (safeScale <= 1) return { x: 0, y: 0 };

  const clamped = clampNormalizedZoomCenter(center, safeScale);
  const halfVisible = 1 / (2 * safeScale);
  return {
    x: clamped.x - halfVisible,
    y: clamped.y - halfVisible,
  };
}

export function applyZoomToPoint(point: Vec2, zoom: { center: Vec2; scale: number }): Vec2 {
  const safeScale = Number.isFinite(zoom.scale) ? Math.max(1, zoom.scale) : 1;
  if (safeScale <= 1) return { x: clamp01(point.x), y: clamp01(point.y) };

  const crop = normalizedZoomCropTopLeft(zoom.center, safeScale);
  return {
    x: clamp01((point.x - crop.x) * safeScale),
    y: clamp01((point.y - crop.y) * safeScale),
  };
}

export function applyZoomToBounds(
  bounds: { x: number; y: number; w: number; h: number },
  zoom: { center: Vec2; scale: number },
): { x: number; y: number; w: number; h: number } {
  const topLeft = applyZoomToPoint({ x: bounds.x, y: bounds.y }, zoom);
  const bottomRight = applyZoomToPoint({ x: bounds.x + bounds.w, y: bounds.y + bounds.h }, zoom);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: Math.max(0, bottomRight.x - topLeft.x),
    h: Math.max(0, bottomRight.y - topLeft.y),
  };
}

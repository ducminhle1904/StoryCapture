import type { Vec2, ZoomClip } from "./timeline-slice";

export interface ZoomTiming {
  inEndMs: number;
  outStartMs: number;
}

export type ZoomEasing = "linear" | "ease-in-cubic" | "ease-out-cubic" | "ease-in-out-cubic";

export interface ResolvedZoomKeyframe extends ZoomSample {
  timeMs: number;
  /** Easing applied from this keyframe to the next one. */
  easing: ZoomEasing;
}

export interface ResolvedZoomMotion {
  startMs: number;
  endMs: number;
  sourceClip: ZoomClip;
  keyframes: ResolvedZoomKeyframe[];
}

export interface ZoomSample {
  center: Vec2;
  scale: number;
}

export const MIN_RESIZABLE_ZOOM_DURATION_MS = 900;
export const AUTO_ZOOM_HANDOFF_GAP_MS = 1_000;
const MIN_HOLD_MS = 550;
const MAX_ZOOM_EDGE_MS = 550;

function safeScale(scale: number): number {
  return Number.isFinite(scale) ? Math.max(1, scale) : 1;
}

export function zoomTiming(
  clip: Pick<ZoomClip, "startMs" | "durationMs"> & Partial<Pick<ZoomClip, "scale">>,
): ZoomTiming {
  const durationMs = Math.max(1, Number.isFinite(clip.durationMs) ? clip.durationMs : 1);
  const intensity = Math.min(1, Math.max(0, (safeScale(clip.scale ?? 1) - 1) / 0.5));
  const desiredInMs = 450 + 100 * intensity;
  const desiredOutMs = desiredInMs;
  const availableEdgeMs = Math.max(1, durationMs - Math.min(MIN_HOLD_MS, durationMs / 3));
  const desiredTotalMs = desiredInMs + desiredOutMs;
  const compression = Math.min(1, availableEdgeMs / desiredTotalMs);
  const inMs = Math.min(MAX_ZOOM_EDGE_MS, Math.max(1, Math.round(desiredInMs * compression)));
  const outMs = Math.min(MAX_ZOOM_EDGE_MS, Math.max(1, Math.round(desiredOutMs * compression)));
  return {
    inEndMs: clip.startMs + inMs,
    outStartMs: Math.max(clip.startMs + inMs, clip.startMs + durationMs - outMs),
  };
}

export function zoomEaseInOutCubic(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function zoomEase(value: number, easing: ZoomEasing): number {
  const t = Math.max(0, Math.min(1, value));
  if (easing === "linear") return t;
  if (easing === "ease-in-cubic") return t ** 3;
  if (easing === "ease-out-cubic") return 1 - (1 - t) ** 3;
  return zoomEaseInOutCubic(t);
}

function zoomTarget(clip: ZoomClip): ZoomSample {
  const scale = safeScale(clip.scale);
  return { scale, center: clampNormalizedZoomCenter(clip.center, scale) };
}

function appendKeyframe(keyframes: ResolvedZoomKeyframe[], keyframe: ResolvedZoomKeyframe): void {
  const previous = keyframes.at(-1);
  if (previous && previous.timeMs === keyframe.timeMs) {
    keyframes[keyframes.length - 1] = keyframe;
    return;
  }
  keyframes.push(keyframe);
}

function normalMotion(clip: ZoomClip): ResolvedZoomMotion {
  const timing = zoomTiming(clip);
  const target = zoomTarget(clip);
  const rest = { scale: 1, center: clampNormalizedZoomCenter(clip.center, 1) };
  return {
    startMs: clip.startMs,
    endMs: clip.startMs + clip.durationMs,
    sourceClip: clip,
    keyframes: [
      { ...rest, timeMs: clip.startMs, easing: "ease-out-cubic" },
      { ...target, timeMs: timing.inEndMs, easing: "linear" },
      { ...target, timeMs: timing.outStartMs, easing: "ease-out-cubic" },
      { ...rest, timeMs: clip.startMs + clip.durationMs, easing: "linear" },
    ],
  };
}

function isValidZoomClip(clip: ZoomClip): boolean {
  return Number.isFinite(clip.startMs) && Number.isFinite(clip.durationMs) && clip.durationMs > 0;
}

export function resolveZoomMotion(clips: readonly ZoomClip[]): ResolvedZoomMotion[] {
  const sorted = clips.filter(isValidZoomClip).slice().sort((a, b) => a.startMs - b.startMs);
  const resolved: ResolvedZoomMotion[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const first = sorted[index];
    if (!first) continue;
    if (first.origin !== "auto") {
      resolved.push(normalMotion(first));
      continue;
    }

    const chain = [first];
    while (index + 1 < sorted.length) {
      const previous = chain.at(-1);
      const next = sorted[index + 1];
      if (
        !previous ||
        !next ||
        next.origin !== "auto" ||
        next.startMs - (previous.startMs + previous.durationMs) > AUTO_ZOOM_HANDOFF_GAP_MS
      ) {
        break;
      }
      chain.push(next);
      index += 1;
    }

    if (chain.length === 1) {
      resolved.push(normalMotion(first));
      continue;
    }

    const keyframes = normalMotion(first).keyframes.slice(0, 2);
    for (let chainIndex = 1; chainIndex < chain.length; chainIndex += 1) {
      const clip = chain[chainIndex];
      const previousTarget = zoomTarget(chain[chainIndex - 1]);
      if (!clip) continue;
      appendKeyframe(keyframes, {
        ...previousTarget,
        timeMs: Math.max(keyframes.at(-1)?.timeMs ?? clip.startMs, clip.startMs),
        easing: "ease-in-out-cubic",
      });
      const target = zoomTarget(clip);
      const panDistance = Math.hypot(target.center.x - previousTarget.center.x, target.center.y - previousTarget.center.y);
      const scaleDistance = Math.abs(target.scale - previousTarget.scale) / 0.5;
      const handoffMs = Math.round(450 + 100 * Math.min(1, panDistance + scaleDistance));
      appendKeyframe(keyframes, {
        ...target,
        timeMs: Math.min(clip.startMs + handoffMs, clip.startMs + clip.durationMs),
        easing: "linear",
      });
    }
    const last = chain.at(-1) ?? first;
    const lastTarget = zoomTarget(last);
    const lastTiming = zoomTiming(last);
    appendKeyframe(keyframes, {
      ...lastTarget,
      timeMs: lastTiming.outStartMs,
      easing: "ease-out-cubic",
    });
    appendKeyframe(keyframes, {
      scale: 1,
      center: clampNormalizedZoomCenter(last.center, 1),
      timeMs: last.startMs + last.durationMs,
      easing: "linear",
    });
    resolved.push({
      startMs: first.startMs,
      endMs: last.startMs + last.durationMs,
      sourceClip: first,
      keyframes,
    });
  }
  return resolved;
}

export function sampleResolvedZoom(motions: readonly ResolvedZoomMotion[], playheadMs: number): ZoomSample {
  let active: ResolvedZoomMotion | undefined;
  for (const motion of motions) {
    if (playheadMs < motion.startMs || playheadMs >= motion.endMs) continue;
    if (!active || motion.startMs >= active.startMs) active = motion;
  }
  if (!active) return { scale: 1, center: { x: 0.5, y: 0.5 } };
  const frames = active.keyframes;
  const first = frames[0];
  if (!first) return { scale: 1, center: { x: 0.5, y: 0.5 } };
  if (playheadMs <= first.timeMs) return { scale: first.scale, center: first.center };
  for (let index = 0; index < frames.length - 1; index += 1) {
    const from = frames[index];
    const to = frames[index + 1];
    if (!from || !to || playheadMs > to.timeMs) continue;
    const progress = zoomEase((playheadMs - from.timeMs) / Math.max(1, to.timeMs - from.timeMs), from.easing);
    return {
      scale: from.scale + (to.scale - from.scale) * progress,
      center: {
        x: from.center.x + (to.center.x - from.center.x) * progress,
        y: from.center.y + (to.center.y - from.center.y) * progress,
      },
    };
  }
  const last = frames.at(-1);
  return last ? { scale: last.scale, center: last.center } : { scale: 1, center: { x: 0.5, y: 0.5 } };
}

export function sampleZoom(clips: readonly ZoomClip[], playheadMs: number): ZoomSample {
  return sampleResolvedZoom(resolveZoomMotion(clips), playheadMs);
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

import type { ActionPoint, ActionTarget } from "./action-timeline";

export interface CursorTimingSize {
  width: number;
  height: number;
}

interface CursorMotionTimingProfile {
  minTravelMs: number;
  maxTravelMs: number;
  travelPxPerMs: number;
  fittsInterceptMs: number;
  fittsSlopeMs: number;
}

const NATURAL_CURSOR_PROFILE: CursorMotionTimingProfile = {
  minTravelMs: 320,
  maxTravelMs: 980,
  travelPxPerMs: 2.4,
  fittsInterceptMs: 120,
  fittsSlopeMs: 135,
};

const MIN_TARGET_WIDTH_PX = 12;

export const HOST_CURSOR_CLICK_RIPPLE_MS = 520;
export const HOST_CURSOR_MIN_FINAL_TAIL_MS =
  NATURAL_CURSOR_PROFILE.minTravelMs + HOST_CURSOR_CLICK_RIPPLE_MS;

export function normalizeCursorTimingSize(
  size: CursorTimingSize | null | undefined,
): CursorTimingSize {
  return {
    width: positiveDimension(size?.width, 1280),
    height: positiveDimension(size?.height, 720),
  };
}

export function initialCursorPoint(size: CursorTimingSize): ActionPoint {
  const normalized = normalizeCursorTimingSize(size);
  return { x: normalized.width / 2, y: normalized.height / 2 };
}

export function cursorPointForTarget(target: ActionTarget, size: CursorTimingSize): ActionPoint {
  const normalized = normalizeCursorTimingSize(size);
  return {
    x: clamp(target.center.x, 0, normalized.width),
    y: clamp(target.center.y, 0, normalized.height),
  };
}

export function estimateCursorTravelDelayMs(input: {
  from: ActionPoint;
  target: ActionTarget;
  size: CursorTimingSize;
}): number {
  const to = cursorPointForTarget(input.target, input.size);
  const distancePx = Math.hypot(to.x - input.from.x, to.y - input.from.y);
  if (distancePx < 1) return 0;

  const ballisticMs = distancePx / NATURAL_CURSOR_PROFILE.travelPxPerMs;
  const indexOfDifficulty = Math.log2(distancePx / targetWidth(input.target) + 1);
  const aimedMs =
    NATURAL_CURSOR_PROFILE.fittsInterceptMs +
    NATURAL_CURSOR_PROFILE.fittsSlopeMs * indexOfDifficulty;
  return Math.round(
    clamp(
      Math.max(ballisticMs, aimedMs),
      NATURAL_CURSOR_PROFILE.minTravelMs,
      NATURAL_CURSOR_PROFILE.maxTravelMs,
    ),
  );
}

function targetWidth(target: ActionTarget): number {
  const bounds = target.bounds;
  return Math.max(MIN_TARGET_WIDTH_PX, Math.min(Math.abs(bounds.w), Math.abs(bounds.h)));
}

function positiveDimension(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

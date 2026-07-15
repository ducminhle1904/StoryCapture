import type {
  ActionCursorMotionPreset,
  ActionCursorTiming,
  ActionInputTiming,
  ActionPoint,
  ActionTarget,
} from "./action-timeline";

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
  curveBend: number;
  overshoot: number;
}

const CURSOR_MOTION_PROFILES: Record<ActionCursorMotionPreset, CursorMotionTimingProfile> = {
  natural: {
    minTravelMs: 320,
    maxTravelMs: 980,
    travelPxPerMs: 2.4,
    fittsInterceptMs: 120,
    fittsSlopeMs: 135,
    curveBend: 0.12,
    overshoot: 0.025,
  },
  snappy: {
    minTravelMs: 160,
    maxTravelMs: 520,
    travelPxPerMs: 5,
    fittsInterceptMs: 70,
    fittsSlopeMs: 85,
    curveBend: 0.06,
    overshoot: 0.012,
  },
  cinematic: {
    minTravelMs: 760,
    maxTravelMs: 1800,
    travelPxPerMs: 1.15,
    fittsInterceptMs: 240,
    fittsSlopeMs: 220,
    curveBend: 0.18,
    overshoot: 0.032,
  },
};

const MIN_TARGET_WIDTH_PX = 12;
const CURSOR_PATH_SAMPLE_INTERVAL_MS = 32;
const CURSOR_PATH_MAX_SAMPLES = 60;
const SETTLE_START = 0.86;

export const HOST_CURSOR_CLICK_RIPPLE_MS = 520;
export const HOST_CURSOR_MIN_FINAL_TAIL_MS =
  CURSOR_MOTION_PROFILES.natural.minTravelMs + HOST_CURSOR_CLICK_RIPPLE_MS;

export const HOST_CURSOR_DEFAULT_MOTION_PRESET: ActionCursorMotionPreset = "natural";
export const HOST_CURSOR_DEFAULT_MIN_LEAD_MS = CURSOR_MOTION_PROFILES.natural.minTravelMs;
export const HOST_CURSOR_TARGET_STABILITY_THRESHOLD_PX = 8;

export interface CursorActionTimingPlan {
  from: ActionPoint;
  to: ActionPoint;
  motionPreset: ActionCursorMotionPreset;
  requiredTravelMs: number;
  systemFloorMs: number;
  configuredMinLeadMs: number;
  preActionDelayMs: number;
  dwellMs: number;
}

export interface CursorActionTimingInput {
  from: ActionPoint;
  target: ActionTarget;
  size: CursorTimingSize;
  motionPreset?: ActionCursorMotionPreset;
  minLeadMs?: number;
}

export interface CursorTimelineTimingInput {
  plan: CursorActionTimingPlan;
  verb: string;
  stepStartedAtMs: number;
  actionAtMs: number;
}

export interface CursorPathSampleInput {
  from: ActionPoint;
  to: ActionPoint;
  travelMs: number;
  motionPreset?: ActionCursorMotionPreset;
  eventKey?: string;
  intervalMs?: number;
}

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
  motionPreset?: ActionCursorMotionPreset;
}): number {
  const to = cursorPointForTarget(input.target, input.size);
  const profile = cursorMotionTimingProfile(input.motionPreset);
  const distancePx = Math.hypot(to.x - input.from.x, to.y - input.from.y);
  if (distancePx < 1) return 0;

  const ballisticMs = distancePx / profile.travelPxPerMs;
  const indexOfDifficulty = Math.log2(distancePx / targetWidth(input.target) + 1);
  const aimedMs = profile.fittsInterceptMs + profile.fittsSlopeMs * indexOfDifficulty;
  return Math.round(
    clamp(Math.max(ballisticMs, aimedMs), profile.minTravelMs, profile.maxTravelMs),
  );
}

export function normalizeCursorMotionPreset(
  preset: ActionCursorMotionPreset | null | undefined,
): ActionCursorMotionPreset {
  return preset === "snappy" || preset === "cinematic" ? preset : "natural";
}

export function cursorMotionTimingProfile(
  preset: ActionCursorMotionPreset | null | undefined,
): CursorMotionTimingProfile {
  return CURSOR_MOTION_PROFILES[normalizeCursorMotionPreset(preset)];
}

export function planCursorActionTiming(input: CursorActionTimingInput): CursorActionTimingPlan {
  const motionPreset = normalizeCursorMotionPreset(input.motionPreset);
  const profile = cursorMotionTimingProfile(motionPreset);
  const to = cursorPointForTarget(input.target, input.size);
  const requiredTravelMs = estimateCursorTravelDelayMs({
    from: input.from,
    target: input.target,
    size: input.size,
    motionPreset,
  });
  const systemFloorMs = profile.minTravelMs;
  const configuredMinLeadMs = Math.max(nonNegativeNumber(input.minLeadMs, 0), systemFloorMs);
  const preActionDelayMs = Math.max(requiredTravelMs, configuredMinLeadMs);

  return {
    from: input.from,
    to,
    motionPreset,
    requiredTravelMs,
    systemFloorMs,
    configuredMinLeadMs,
    preActionDelayMs,
    dwellMs: Math.max(0, preActionDelayMs - requiredTravelMs),
  };
}

export function cursorTimelineTimingFromPlan(input: CursorTimelineTimingInput): {
  cursorTiming: ActionCursorTiming;
  inputTiming: ActionInputTiming;
} {
  const stepStartedAtMs = nonNegativeMs(input.stepStartedAtMs);
  const actionAtMs = Math.max(stepStartedAtMs, nonNegativeMs(input.actionAtMs));
  const plannedArrivalMs = stepStartedAtMs + input.plan.requiredTravelMs;
  const arrivalMs = Math.min(actionAtMs, plannedArrivalMs);
  const travelMs = Math.max(0, arrivalMs - stepStartedAtMs);
  const dwellMs = Math.max(0, actionAtMs - arrivalMs);
  const kind = inputKindForVerb(input.verb);
  const hasPointerPress =
    kind === "click" || kind === "focus" || kind === "type" || kind === "select" || kind === "drag";

  return {
    cursorTiming: {
      motion_preset: input.plan.motionPreset,
      start_ms: stepStartedAtMs,
      arrival_ms: arrivalMs,
      travel_ms: travelMs,
      dwell_ms: dwellMs,
    },
    inputTiming: {
      kind,
      ...(hasPointerPress
        ? {
            down_ms: actionAtMs,
            up_ms: actionAtMs,
          }
        : {}),
      action_ms: actionAtMs,
      ...(kind === "type" || kind === "select"
        ? {
            text_start_ms: actionAtMs,
            text_end_ms: actionAtMs,
          }
        : {}),
    },
  };
}

export function targetCenterDeltaPx(a: ActionTarget, b: ActionTarget): number {
  return Math.hypot(b.center.x - a.center.x, b.center.y - a.center.y);
}

export function sampleCursorMotionPath(input: CursorPathSampleInput): ActionPoint[] {
  const motionPreset = normalizeCursorMotionPreset(input.motionPreset);
  const profile = cursorMotionTimingProfile(motionPreset);
  const travelMs = Math.max(0, Math.round(input.travelMs));
  const distancePx = Math.hypot(input.to.x - input.from.x, input.to.y - input.from.y);
  if (travelMs <= 0 || distancePx < 1) return [input.to];
  const intervalMs = Math.max(8, Math.round(input.intervalMs ?? CURSOR_PATH_SAMPLE_INTERVAL_MS));
  const sampleCount = Math.max(
    2,
    Math.min(CURSOR_PATH_MAX_SAMPLES, Math.ceil(travelMs / intervalMs)),
  );
  return Array.from({ length: sampleCount }, (_, index) => {
    const progress = (index + 1) / sampleCount;
    return curvedCursorPoint(input.from, input.to, input.eventKey ?? "", progress, profile);
  });
}

function targetWidth(target: ActionTarget): number {
  const bounds = target.bounds;
  return Math.max(MIN_TARGET_WIDTH_PX, Math.min(Math.abs(bounds.w), Math.abs(bounds.h)));
}

function inputKindForVerb(verb: string): ActionInputTiming["kind"] {
  switch (verb) {
    case "click":
      return "click";
    case "hover":
      return "hover";
    case "type":
      return "type";
    case "select":
      return "select";
    case "scroll":
      return "scroll";
    case "drag":
      return "drag";
    case "upload":
      return "upload";
    default:
      return "focus";
  }
}

function curvedCursorPoint(
  from: ActionPoint,
  to: ActionPoint,
  eventKey: string,
  rawProgress: number,
  profile: CursorMotionTimingProfile,
): ActionPoint {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < 1) return to;

  const progress = smootherstep(rawProgress);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const nx = -dy / d;
  const ny = dx / d;
  const bend = clamp(d * profile.curveBend, 18, 90) * curveSign(eventKey, from, to);
  const control = {
    x: (from.x + to.x) / 2 + nx * bend,
    y: (from.y + to.y) / 2 + ny * bend,
  };
  const overshootDistance = clamp(d * profile.overshoot, 0, 14);
  const overshoot = {
    x: to.x + (dx / d) * overshootDistance,
    y: to.y + (dy / d) * overshootDistance,
  };

  if (progress < SETTLE_START && overshootDistance > 0) {
    return quadraticBezier(from, control, overshoot, progress / SETTLE_START);
  }

  const settle = smootherstep((progress - SETTLE_START) / (1 - SETTLE_START));
  return {
    x: overshoot.x + (to.x - overshoot.x) * settle,
    y: overshoot.y + (to.y - overshoot.y) * settle,
  };
}

function quadraticBezier(a: ActionPoint, c: ActionPoint, b: ActionPoint, t: number): ActionPoint {
  const inv = 1 - t;
  return {
    x: inv * inv * a.x + 2 * inv * t * c.x + t * t * b.x,
    y: inv * inv * a.y + 2 * inv * t * c.y + t * t * b.y,
  };
}

function curveSign(eventKey: string, from: ActionPoint, to: ActionPoint): number {
  const key = `${eventKey}:${Math.round(from.x)},${Math.round(from.y)}:${Math.round(
    to.x,
  )},${Math.round(to.y)}`;
  return hashString(key) % 2 === 0 ? 1 : -1;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function smootherstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function positiveDimension(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function nonNegativeMs(value: unknown): number {
  return Math.max(0, Math.round(nonNegativeNumber(value, 0)));
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

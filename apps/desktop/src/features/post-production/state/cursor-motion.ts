import type { CursorMotionPreset } from "./timeline-slice";
import { normalizeCursorMotionPreset } from "./timeline-slice";

export interface CursorMotionProfile {
  minTravelMs: number;
  maxTravelMs: number;
  travelPxPerMs: number;
  fittsInterceptMs: number;
  fittsSlopeMs: number;
  curveBend: number;
  overshoot: number;
}

export const CURSOR_MOTION_LABELS: Record<CursorMotionPreset, string> = {
  natural: "Natural",
  snappy: "Snappy",
  cinematic: "Cinematic",
};

const CURSOR_MOTION_PROFILES: Record<CursorMotionPreset, CursorMotionProfile> = {
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

export function cursorMotionProfile(
  motionPreset: CursorMotionPreset | undefined,
): CursorMotionProfile {
  return CURSOR_MOTION_PROFILES[normalizeCursorMotionPreset(motionPreset)];
}

import type { CursorMotionPreset } from "./timeline-slice";
import { normalizeCursorMotionPreset } from "./timeline-slice";

export interface CursorMotionProfile {
  minTravelMs: number;
  maxTravelMs: number;
  travelPxPerMs: number;
}

export const CURSOR_MOTION_LABELS: Record<CursorMotionPreset, string> = {
  natural: "Natural",
  snappy: "Snappy",
  cinematic: "Cinematic",
};

const CURSOR_MOTION_PROFILES: Record<CursorMotionPreset, CursorMotionProfile> = {
  natural: { minTravelMs: 320, maxTravelMs: 980, travelPxPerMs: 2.4 },
  snappy: { minTravelMs: 160, maxTravelMs: 520, travelPxPerMs: 5 },
  cinematic: { minTravelMs: 760, maxTravelMs: 1800, travelPxPerMs: 1.15 },
};

export function cursorMotionProfile(
  motionPreset: CursorMotionPreset | undefined,
): CursorMotionProfile {
  return CURSOR_MOTION_PROFILES[normalizeCursorMotionPreset(motionPreset)];
}

import type { OutputResolutionDto } from "@storycapture/shared-types";
import type { RecordingQualityPreset } from "@/state/output-prefs";

export interface Dims {
  w: number;
  h: number;
}

const Q_MUL: Record<RecordingQualityPreset, number> = {
  high: 1.25,
  lossless: 1.5,
};

const CUSTOM_MIN_W = 16;
const CUSTOM_MIN_H = 16;
const CUSTOM_MAX_W = 7680;
const CUSTOM_MAX_H = 4320;

export function resolveDims(res: OutputResolutionDto, capture?: Dims): Dims {
  switch (res.kind) {
    case "p720":
      return { w: 1280, h: 720 };
    case "p1080":
      return { w: 1920, h: 1080 };
    case "p1440":
      return { w: 2560, h: 1440 };
    case "p2160":
      return { w: 3840, h: 2160 };
    case "match-source":
      return capture ?? { w: 0, h: 0 };
    case "custom":
      return { w: res.w, h: res.h };
  }
}

export function computeBitratePreview({
  w,
  h,
  quality,
}: {
  w: number;
  h: number;
  quality: RecordingQualityPreset;
}): { mbps: number; mbPerMin: number } {
  if (w <= 0 || h <= 0) return { mbps: 0, mbPerMin: 0 };
  const kbps = ((w * h * 3) / 1000) * Q_MUL[quality];
  const mbps = kbps / 1000;
  const mbPerMin = (kbps * 60) / 8 / 1024;
  return { mbps, mbPerMin };
}

export function formatBitratePreview(mbps: number, mbPerMin: number): string {
  return `~${mbps.toFixed(1)} Mbps • ~${Math.round(mbPerMin)} MB/min`;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: "odd-width" | "odd-height" | "out-of-range" };

export function validateCustomDims(w: number, h: number): ValidationResult {
  if (
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w < CUSTOM_MIN_W ||
    w > CUSTOM_MAX_W ||
    h < CUSTOM_MIN_H ||
    h > CUSTOM_MAX_H
  ) {
    return { valid: false, reason: "out-of-range" };
  }
  if (w % 2 !== 0) return { valid: false, reason: "odd-width" };
  if (h % 2 !== 0) return { valid: false, reason: "odd-height" };
  return { valid: true };
}

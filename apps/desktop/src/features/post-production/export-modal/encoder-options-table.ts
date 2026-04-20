/**
 * deriveQualityControls — pure decision table implementing UI-SPEC lines 206-216.
 * Phase 13 Plan 05: maps (encoder, codec) → which rate-control options, which
 * quality control (CRF slider / CQ slider / bitrate number / auto-hide), and
 * which encoder preset list the Advanced accordion should render.
 */

import type { ExportCodec, ExportKnobs, ExportRateControl } from "@/state/output-prefs";

import { LABEL_AUTO_HIDE_NOTE, LABEL_LIBOPENH264_NOTE } from "./advanced-copy";

export type QualityControlSpec =
  | { kind: "slider-crf"; min: 0; max: 51; default: number }
  | { kind: "slider-cq"; min: 0; max: 51; default: number }
  | { kind: "number-bitrate-mbps"; min: 1; max: 50; default: number }
  | { kind: "auto-hide"; note: string }
  | { kind: "none" };

export interface RateControlOption {
  value: ExportRateControl;
  locked?: boolean;
}

export interface QualityControlsResult {
  rateControlOptions: ReadonlyArray<RateControlOption>;
  qualityControl: QualityControlSpec;
  presetOptions: ReadonlyArray<string>;
  note?: string;
}

const X264_PRESETS = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow",
] as const;

const NVENC_PRESETS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const;
const VT_PRESETS = ["speed", "quality"] as const;
const QSV_PRESETS = ["veryfast", "faster", "fast", "medium", "slow", "slower"] as const;
const AMF_PRESETS = ["speed", "balanced", "quality"] as const;

export function deriveQualityControls(
  encoder: ExportKnobs["hwEncoder"],
  _codec: ExportCodec,
): QualityControlsResult {
  switch (encoder) {
    case "auto":
      return {
        rateControlOptions: [],
        qualityControl: { kind: "auto-hide", note: LABEL_AUTO_HIDE_NOTE },
        presetOptions: [],
      };
    case "software":
    case "libx264":
      return {
        rateControlOptions: [{ value: "crf" }, { value: "cbr" }, { value: "vbr" }],
        qualityControl: { kind: "slider-crf", min: 0, max: 51, default: 18 },
        presetOptions: X264_PRESETS,
      };
    case "h264-nvenc":
    case "hevc-nvenc":
      return {
        rateControlOptions: [{ value: "vbr", locked: true }],
        qualityControl: { kind: "slider-cq", min: 0, max: 51, default: 19 },
        presetOptions: NVENC_PRESETS,
      };
    case "h264-videotoolbox":
    case "hevc-videotoolbox":
      return {
        rateControlOptions: [{ value: "vbr" }],
        qualityControl: { kind: "number-bitrate-mbps", min: 1, max: 50, default: 8 },
        presetOptions: VT_PRESETS,
      };
    case "h264-qsv":
      return {
        rateControlOptions: [{ value: "vbr" }, { value: "cbr" }],
        qualityControl: { kind: "number-bitrate-mbps", min: 1, max: 50, default: 8 },
        presetOptions: QSV_PRESETS,
      };
    case "h264-amf":
      return {
        rateControlOptions: [{ value: "vbr" }, { value: "cbr" }],
        qualityControl: { kind: "number-bitrate-mbps", min: 1, max: 50, default: 8 },
        presetOptions: AMF_PRESETS,
      };
    case "libopenh264":
      return {
        rateControlOptions: [{ value: "cbr" }],
        qualityControl: { kind: "number-bitrate-mbps", min: 1, max: 50, default: 4 },
        presetOptions: [],
        note: LABEL_LIBOPENH264_NOTE,
      };
    default:
      return {
        rateControlOptions: [{ value: "vbr" }],
        qualityControl: { kind: "number-bitrate-mbps", min: 1, max: 50, default: 8 },
        presetOptions: [],
      };
  }
}

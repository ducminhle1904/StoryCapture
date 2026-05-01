import type {
  FitModeDto,
  OutputResolutionDto,
  PadColorDto,
  QualityPresetDto,
} from "@storycapture/shared-types";
import type { PresetName, RecordingPacingProfile } from "@/state/output-prefs";

/* Section */
export const SECTION_TITLE = "Video output";

/* Preset */
export const LABEL_PRESET = "Preset";
export const PRESET_OPTION_LABELS: Record<PresetName, string> = {
  Standard: "Standard",
  Lossless: "Lossless",
  Custom: "Custom",
};

/* Resolution */
export const LABEL_RESOLUTION = "Resolution";
export const RESOLUTION_OPTION_LABELS: Record<OutputResolutionDto["kind"], string> = {
  p720: "720p",
  p1080: "1080p",
  p1440: "1440p",
  p2160: "4K",
  "match-source": "Match source",
  custom: "Custom…",
};
export const LABEL_CUSTOM_W = "Width";
export const LABEL_CUSTOM_H = "Height";
export const HELPER_CUSTOM_DIMS = "Even numbers, 16–7680 × 16–4320";

/* FPS */
export const LABEL_FPS = "FPS";

/* Fit mode */
export const LABEL_FIT = "Fit mode";
export const FIT_OPTION_LABELS: Record<FitModeDto, string> = {
  letterbox: "Letterbox",
  "fill-crop": "Crop",
  stretch: "Stretch",
};

/* Pad color */
export const LABEL_PAD = "Pad color";
export const PAD_OPTION_LABELS: Record<PadColorDto["kind"], string> = {
  black: "Black",
  white: "White",
  custom: "Custom",
};

/* Quality */
export const LABEL_QUALITY = "Quality";
export const QUALITY_OPTION_LABELS: Record<QualityPresetDto, string> = {
  low: "Low",
  med: "Medium",
  high: "Standard",
  lossless: "Lossless",
};

/* Pacing */
export const LABEL_PACING = "Pacing";
export const PACING_OPTION_LABELS: Record<RecordingPacingProfile, string> = {
  normal: "1x",
};

/* Warnings */
export const WARN_HARD_CUSTOM_DIMS = "Width/height must be even numbers within 16–7680 × 16–4320.";
export const WARN_SOFT_LOSSLESS_4K_HW =
  "Lossless quality at 4K with a HW encoder creates very large All-I files. Consider Standard for routine recordings.";
export const WARN_SOFT_OUTPUT_GT_CAPTURE =
  "Capture source is smaller than the output size — the video will keep the source size and add padding instead of upscaling (so text stays sharp).";

/* Badge */
export const BADGE_TOOLTIP = "Click to view video output details";
export const BADGE_PAD_PREFIX = "Pad";

/* Preview */
export const PREVIEW_LOADING = "Computing…";

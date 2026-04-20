import type { PresetName } from "@/state/output-prefs";
import type {
  FitModeDto,
  OutputResolutionDto,
  PadColorDto,
  QualityPresetDto,
} from "@storycapture/shared-types";

/* Section */
export const SECTION_TITLE = "Đầu ra video";

/* Preset */
export const LABEL_PRESET = "Preset";
export const PRESET_OPTION_LABELS: Record<PresetName, string> = {
  Quick: "Nhanh",
  Standard: "Tiêu chuẩn",
  "High Quality": "Chất lượng cao",
  Custom: "Tùy chỉnh",
};

/* Resolution */
export const LABEL_RESOLUTION = "Độ phân giải";
export const RESOLUTION_OPTION_LABELS: Record<OutputResolutionDto["kind"], string> = {
  p720: "720p",
  p1080: "1080p",
  p1440: "1440p",
  p2160: "4K",
  "match-source": "Khớp với nguồn",
  custom: "Tùy chỉnh…",
};
export const LABEL_CUSTOM_W = "Rộng";
export const LABEL_CUSTOM_H = "Cao";
export const HELPER_CUSTOM_DIMS = "Chẵn, 16–7680 × 16–4320";

/* FPS */
export const LABEL_FPS = "FPS";

/* Fit mode */
export const LABEL_FIT = "Chế độ lấp khung";
export const FIT_OPTION_LABELS: Record<FitModeDto, string> = {
  letterbox: "Letterbox",
  "fill-crop": "Cắt",
  stretch: "Kéo giãn",
};

/* Pad color */
export const LABEL_PAD = "Màu viền";
export const PAD_OPTION_LABELS: Record<PadColorDto["kind"], string> = {
  black: "Đen",
  white: "Trắng",
  custom: "Tùy chỉnh",
};

/* Quality */
export const LABEL_QUALITY = "Chất lượng";
export const QUALITY_OPTION_LABELS: Record<QualityPresetDto, string> = {
  low: "Thấp",
  med: "Trung bình",
  high: "Cao",
  lossless: "Lossless",
};

/* Warnings */
export const WARN_HARD_CUSTOM_DIMS =
  "Chiều rộng/cao phải là số chẵn và trong khoảng 16–7680 × 16–4320.";
export const WARN_SOFT_LOSSLESS_4K_HW =
  "Chất lượng Lossless ở 4K với HW encoder có thể vượt bitrate cap phần cứng và khiến render chậm. Cân nhắc giảm xuống Cao hoặc chuyển sang Software (libx264).";
export const WARN_SOFT_OUTPUT_GT_CAPTURE =
  "Nguồn ghi nhỏ hơn kích thước output — video sẽ giữ nguyên kích thước nguồn và thêm viền thay vì phóng to (không làm mờ text).";

/* Badge */
export const BADGE_TOOLTIP = "Nhấn để xem chi tiết đầu ra video";
export const BADGE_PAD_PREFIX = "Viền";

/* Preview */
export const PREVIEW_LOADING = "Đang tính…";

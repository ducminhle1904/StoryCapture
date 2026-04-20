/**
 * Vietnamese copy constants for the Export Modal Advanced accordion
 * (Phase 13 Plan 05, ENC-13 + ENC-16). Centralised per CD-13-03.
 */

export const LABEL_ACCORDION_TRIGGER = "Tùy chọn nâng cao";

export const LABEL_GROUP_CONTAINER_CODEC = "Định dạng & Codec";
export const LABEL_GROUP_ENCODER_QUALITY = "Bộ mã hóa & Chất lượng";
export const LABEL_GROUP_KEYFRAME_AUDIO = "Keyframe / Kích thước / Âm thanh";

export const LABEL_CONTAINER = "Định dạng tệp";
export const LABEL_CODEC = "Codec";
export const LABEL_HW_ENCODER = "Bộ mã hóa phần cứng";
export const LABEL_RATE_CONTROL = "Kiểm soát bitrate";
export const LABEL_QUALITY_SLIDER = "Chất lượng (thấp hơn = tốt hơn)";
export const LABEL_BITRATE_MBPS = "Bitrate (Mbps)";
export const LABEL_PRESET = "Tốc độ mã hóa";
export const LABEL_KEYFRAME = "Khoảng keyframe (giây)";
export const LABEL_DOWNSCALE = "Thuật toán giảm kích thước";
export const LABEL_AUDIO_CODEC = "Codec âm thanh";
export const LABEL_AUDIO_BITRATE = "Bitrate âm thanh";
export const LABEL_AUDIO_CHANNELS = "Kênh";

export const LABEL_AUTO_HIDE_NOTE = "Encoder sẽ được chọn lúc export";
export const LABEL_LIBOPENH264_NOTE = "Fallback encoder — không có preset tuning";

export const WARN_HW_UNAVAILABLE = (name: string): string =>
  `Bộ mã hóa ${name} không có sẵn trên máy này. Chọn Auto hoặc Software (libx264).`;

export const SUFFIX_HW_UNAVAILABLE = "(không khả dụng trên máy này)";

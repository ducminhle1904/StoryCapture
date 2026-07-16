/**
 * Copy constants for the Export Modal Advanced accordion.
 */

export const LABEL_ACCORDION_TRIGGER = "Advanced options";

export const LABEL_GROUP_CONTAINER_CODEC = "Format & Codec";
export const LABEL_GROUP_ENCODER_QUALITY = "Encoder & Quality";
export const LABEL_GROUP_KEYFRAME_AUDIO = "Keyframe / Resolution / Audio";

export const LABEL_CONTAINER = "File format";
export const LABEL_CODEC = "Codec";
export const LABEL_HW_ENCODER = "Hardware encoder";
export const LABEL_RATE_CONTROL = "Rate control";
export const LABEL_QUALITY_SLIDER = "Quality (lower = better)";
export const LABEL_BITRATE_MBPS = "Bitrate (Mbps)";
export const LABEL_PRESET = "Encoding speed";
export const LABEL_KEYFRAME = "Keyframe interval (seconds)";
export const LABEL_DOWNSCALE = "Resampling quality";
export const LABEL_AUDIO_CODEC = "Audio codec";
export const LABEL_AUDIO_BITRATE = "Audio bitrate";
export const LABEL_AUDIO_CHANNELS = "Channels";

export const LABEL_AUTO_HIDE_NOTE =
  "Auto uses software libx264 with CRF quality for stable, deterministic output.";
export const LABEL_LIBOPENH264_NOTE = "Fallback encoder — no preset tuning";

export const WARN_HW_UNAVAILABLE = (name: string): string =>
  `Hardware encoder ${name} is not available on this machine. Choose Auto or Software (libx264).`;

export const SUFFIX_HW_UNAVAILABLE = "(not available on this machine)";

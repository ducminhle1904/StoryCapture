//! Output format catalogue for EXPORT-02.
//!
//! Three end-user-visible formats; each has a fixed container, primary
//! video codec, and (optionally) audio codec. Backing encoder argv is
//! assembled in [`crate::fanout::multi_encode::build_encode_args`] — this
//! module only owns the catalogue + string labels.

use serde::{Deserialize, Serialize};

/// Thin newtype wrapper so the TS binding is `string` with semantic meaning.
pub type ContainerExt = &'static str;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Mp4,
    WebM,
    Gif,
}

impl OutputFormat {
    pub fn extension(self) -> ContainerExt {
        match self {
            Self::Mp4 => "mp4",
            Self::WebM => "webm",
            Self::Gif => "gif",
        }
    }

    pub fn container(self) -> ContainerExt {
        // Containers currently match extensions; kept separate so future
        // `.mov` or `.mkv` variants can reuse the H.264 codec.
        self.extension()
    }

    pub fn primary_video_codec(self) -> &'static str {
        match self {
            Self::Mp4 => "h264",
            Self::WebM => "vp9",
            Self::Gif => "gif",
        }
    }

    pub fn audio_codec(self) -> Option<&'static str> {
        match self {
            Self::Mp4 => Some("aac"),
            Self::WebM => Some("opus"),
            Self::Gif => None,
        }
    }

    pub fn all() -> &'static [OutputFormat] {
        &[Self::Mp4, Self::WebM, Self::Gif]
    }
}

/// Convenience wrapper mirroring the plan's exported API.
pub fn codec_for(f: OutputFormat) -> &'static str {
    f.primary_video_codec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_extensions() {
        assert_eq!(OutputFormat::Mp4.extension(), "mp4");
        assert_eq!(OutputFormat::WebM.extension(), "webm");
        assert_eq!(OutputFormat::Gif.extension(), "gif");
    }

    #[test]
    fn format_codecs() {
        assert_eq!(OutputFormat::Mp4.primary_video_codec(), "h264");
        assert_eq!(OutputFormat::WebM.primary_video_codec(), "vp9");
        assert_eq!(OutputFormat::Gif.audio_codec(), None);
        assert_eq!(OutputFormat::Mp4.audio_codec(), Some("aac"));
        assert_eq!(OutputFormat::WebM.audio_codec(), Some("opus"));
    }

    #[test]
    fn format_roundtrip_json() {
        let j = serde_json::to_string(&OutputFormat::WebM).unwrap();
        assert_eq!(j, "\"webm\"");
        let f: OutputFormat = serde_json::from_str("\"mp4\"").unwrap();
        assert_eq!(f, OutputFormat::Mp4);
    }
}

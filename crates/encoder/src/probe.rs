//! Runtime hardware-encoder feature detection (D-24 / ENC-02).
//!
//! Spawns `ffmpeg -hide_banner -encoders` once at startup and parses the
//! output for the H.264 encoders we care about. Result is cached on
//! `AppState` for the session (no re-probe per recording).
//!
//! Preference order (D-24):
//!   - macOS: `VideoToolboxH264`
//!   - Windows: `NvencH264` > `QsvH264` > `AmfH264`
//!   - Fallback (any OS): `Openh264Software` (LGPL Cisco reference encoder)
//!
//! If no encoder is detected — including the libopenh264 fallback — the
//! probe returns `EncoderError::NoEncoderAvailable` with a diagnostic
//! pointing at the LGPL build recipe (Plan 01-02).

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::error::{EncoderError, Result};
use crate::sidecar::SidecarCommand;

/// Encoders the runtime probe can select. Kept deliberately small — Phase 1
/// scope is H.264 only (D-25). HEVC variants listed for completeness but
/// never preferred in Phase 1; Phase 2 will extend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HardwareEncoder {
    VideoToolboxH264,
    VideoToolboxHevc,
    NvencH264,
    QsvH264,
    AmfH264,
    /// LGPL software fallback. Always preferred over "nothing" but never
    /// preferred over any hardware encoder.
    Openh264Software,
}

impl HardwareEncoder {
    /// FFmpeg `-c:v` codec name.
    pub fn ffmpeg_codec_name(self) -> &'static str {
        match self {
            HardwareEncoder::VideoToolboxH264 => "h264_videotoolbox",
            HardwareEncoder::VideoToolboxHevc => "hevc_videotoolbox",
            HardwareEncoder::NvencH264 => "h264_nvenc",
            HardwareEncoder::QsvH264 => "h264_qsv",
            HardwareEncoder::AmfH264 => "h264_amf",
            HardwareEncoder::Openh264Software => "libopenh264",
        }
    }

    /// Substring to grep for in `ffmpeg -encoders` output.
    fn probe_token(self) -> &'static str {
        self.ffmpeg_codec_name()
    }
}

/// Result of `probe_encoders`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncoderProbe {
    pub available: Vec<HardwareEncoder>,
    pub preferred: HardwareEncoder,
}

/// Spawns `ffmpeg -hide_banner -encoders`, reads stdout to EOF, parses
/// visible encoder names. Returns the union of available encoders plus a
/// preferred pick per platform.
pub async fn probe_encoders(cmd: &dyn SidecarCommand) -> Result<EncoderProbe> {
    let args: Vec<String> = vec!["-hide_banner".into(), "-encoders".into()];
    let mut child = cmd.spawn(args).await?;

    let mut out = String::new();
    child
        .stdout
        .read_to_string(&mut out)
        .await
        .map_err(|e| EncoderError::ProbeFailed(format!("stdout read: {e}")))?;

    // Wait for child exit to avoid zombies. Probe output is small (~20 KiB)
    // so we don't stream; we just drain and wait.
    let _ = child.child.wait().await;

    let available = parse_encoders_output(&out);

    if available.is_empty() {
        return Err(EncoderError::NoEncoderAvailable(
            "ffmpeg -encoders listed no H.264 encoder (neither hardware nor libopenh264 fallback). Ensure the LGPL build from scripts/build-ffmpeg/ was produced with --enable-libopenh264.".into(),
        ));
    }

    let preferred = pick_preferred(&available);
    Ok(EncoderProbe {
        available,
        preferred,
    })
}

/// Parse the output of `ffmpeg -hide_banner -encoders` and return the
/// encoders we care about.
///
/// FFmpeg emits lines of the form (note the leading space):
/// ```text
///  V..... h264_videotoolbox    VideoToolbox H.264 Encoder
///  V..... libopenh264          OpenH264 H.264 / MPEG-4 AVC encoder
/// ```
/// We match by substring against the known codec names — simple and
/// resilient to version-to-version whitespace or capability-flag churn.
fn parse_encoders_output(out: &str) -> Vec<HardwareEncoder> {
    const CANDIDATES: &[HardwareEncoder] = &[
        HardwareEncoder::VideoToolboxH264,
        HardwareEncoder::VideoToolboxHevc,
        HardwareEncoder::NvencH264,
        HardwareEncoder::QsvH264,
        HardwareEncoder::AmfH264,
        HardwareEncoder::Openh264Software,
    ];

    let mut found = Vec::new();
    for &enc in CANDIDATES {
        let token = enc.probe_token();
        // Must appear as a whole word on a line after the 'V.....' prefix.
        for line in out.lines() {
            let trimmed = line.trim_start();
            // Encoder lines start with a flag block like `V..X..` or
            // `VFS..X`. We require the flag block's first char to be V.
            let mut chars = trimmed.chars();
            let first = chars.next();
            if first != Some('V') {
                continue;
            }
            if trimmed
                .split_whitespace()
                .nth(1)
                .map(|name| name == token)
                .unwrap_or(false)
            {
                found.push(enc);
                break;
            }
        }
    }
    found
}

/// Pick preferred encoder per target platform (D-24).
fn pick_preferred(available: &[HardwareEncoder]) -> HardwareEncoder {
    #[cfg(target_os = "macos")]
    let order = &[
        HardwareEncoder::VideoToolboxH264,
        HardwareEncoder::Openh264Software,
    ][..];
    #[cfg(target_os = "windows")]
    let order = &[
        HardwareEncoder::NvencH264,
        HardwareEncoder::QsvH264,
        HardwareEncoder::AmfH264,
        HardwareEncoder::Openh264Software,
    ][..];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let order = &[HardwareEncoder::Openh264Software][..];

    for &pref in order {
        if available.contains(&pref) {
            return pref;
        }
    }
    // Non-empty guarantee is enforced by `probe_encoders` before we call
    // this; if somehow the platform order is disjoint from `available`,
    // return the first available entry.
    available[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_OUTPUT: &str = "\
Encoders:
 V..... = Video
 ------
 V..... libopenh264          OpenH264 H.264 / MPEG-4 AVC encoder
 V..... h264_videotoolbox    VideoToolbox H.264 Encoder
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder
 A..... aac                  AAC (Advanced Audio Coding)
";

    #[test]
    fn parses_known_encoders() {
        let got = parse_encoders_output(SAMPLE_OUTPUT);
        assert!(got.contains(&HardwareEncoder::Openh264Software));
        assert!(got.contains(&HardwareEncoder::VideoToolboxH264));
        assert!(got.contains(&HardwareEncoder::NvencH264));
        assert!(!got.contains(&HardwareEncoder::AmfH264));
    }

    #[test]
    fn empty_input_yields_empty_list() {
        assert!(parse_encoders_output("").is_empty());
    }

    #[test]
    fn preferred_falls_back_to_openh264_when_no_hw() {
        let avail = vec![HardwareEncoder::Openh264Software];
        assert_eq!(pick_preferred(&avail), HardwareEncoder::Openh264Software);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preferred_picks_videotoolbox_on_mac() {
        let avail = vec![
            HardwareEncoder::VideoToolboxH264,
            HardwareEncoder::Openh264Software,
        ];
        assert_eq!(pick_preferred(&avail), HardwareEncoder::VideoToolboxH264);
    }
}

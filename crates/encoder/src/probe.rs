//! Runtime hardware-encoder feature detection.
//!
//! Spawns `ffmpeg -hide_banner -encoders` once at startup and parses the
//! output for the H.264 encoders we care about. Result is cached on
//! `AppState` for the session (no re-probe per recording).
//!
//! Preference order:
//!   - macOS: `VideoToolboxHevc` > `VideoToolboxH264`
//!   - Windows: `NvencH264` > `QsvH264` > `AmfH264`
//!   - Fallback (any OS): `Libx264Software`, then `Openh264Software`
//!
//! If no encoder is detected — including the software fallback — the
//! probe returns `EncoderError::NoEncoderAvailable` with a diagnostic
//! pointing at the FFmpeg build recipe.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use tokio::io::AsyncReadExt;

use crate::error::{EncoderError, Result};
use crate::sidecar::SidecarCommand;

/// Process-wide cache of the last successful probe result. A
/// `parking_lot::RwLock<Option<EncoderProbe>>` lets `force_reprobe`
/// overwrite atomically — a one-shot static cell cannot be reset.
static PROBE_CACHE: LazyLock<RwLock<Option<EncoderProbe>>> = LazyLock::new(|| RwLock::new(None));

/// Encoders the runtime probe can select. Kept deliberately small — scope
/// is H.264 only. HEVC variants are listed for completeness; preferred only
/// when explicitly enabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HardwareEncoder {
    VideoToolboxH264,
    VideoToolboxHevc,
    NvencH264,
    QsvH264,
    AmfH264,
    /// Software H.264 fallback for quality-first MP4 recording.
    Libx264Software,
    /// LGPL software H.264 fallback. It is useful when no hardware encoder
    /// exists, but it does not support x264-style CRF/lossless controls.
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
            HardwareEncoder::Libx264Software => "libx264",
            HardwareEncoder::Openh264Software => "libopenh264",
        }
    }

    /// Substring to grep for in `ffmpeg -encoders` output.
    fn probe_token(self) -> &'static str {
        self.ffmpeg_codec_name()
    }

    /// True for hardware-backed encoders.
    pub fn is_hardware(self) -> bool {
        matches!(
            self,
            HardwareEncoder::VideoToolboxH264
                | HardwareEncoder::VideoToolboxHevc
                | HardwareEncoder::NvencH264
                | HardwareEncoder::QsvH264
                | HardwareEncoder::AmfH264
        )
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
            "ffmpeg -encoders listed no H.264 encoder (neither hardware nor software fallback). Ensure the FFmpeg sidecar was produced with VideoToolbox/NVENC/QSV/AMF or libx264/libopenh264.".into(),
        ));
    }

    let preferred = pick_preferred(&available);
    Ok(EncoderProbe {
        available,
        preferred,
    })
}

/// Returns the cached probe if present, otherwise runs `probe_encoders`
/// and caches the outcome.
pub async fn probe_cached(cmd: &dyn SidecarCommand) -> Result<EncoderProbe> {
    if let Some(cached) = PROBE_CACHE.read().clone() {
        return Ok(cached);
    }
    let fresh = probe_encoders(cmd).await?;
    *PROBE_CACHE.write() = Some(fresh.clone());
    Ok(fresh)
}

/// Bypass the cache and overwrite it with a fresh probe. Call after an
/// eGPU dock/undock or driver update to reflect the new encoder list.
pub async fn force_reprobe(cmd: &dyn SidecarCommand) -> Result<EncoderProbe> {
    let fresh = probe_encoders(cmd).await?;
    *PROBE_CACHE.write() = Some(fresh.clone());
    Ok(fresh)
}

/// Test hook: seed the cache directly. `cfg(test)` only — callers in
/// production must go through `probe_cached` / `force_reprobe`.
#[cfg(test)]
pub(crate) fn __test_set_cache(p: Option<EncoderProbe>) {
    *PROBE_CACHE.write() = p;
}

/// Test hook: observe current cache contents without taking a write lock.
#[cfg(test)]
pub(crate) fn __test_peek_cache() -> Option<EncoderProbe> {
    PROBE_CACHE.read().clone()
}

/// Parse the output of `ffmpeg -hide_banner -encoders` and return the
/// encoders we care about.
///
/// FFmpeg emits lines of the form (note the leading space):
/// ```text
///  V..... h264_videotoolbox    VideoToolbox H.264 Encoder
///  V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC encoder
///  V..... libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC encoder
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
        HardwareEncoder::Libx264Software,
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

/// Pick preferred encoder per target platform.
fn pick_preferred(available: &[HardwareEncoder]) -> HardwareEncoder {
    #[cfg(target_os = "macos")]
    let order = &[
        // HEVC first — Apple Silicon's VT HEVC encoder gives ~40% better
        // compression at the same perceptual quality than H.264, which
        // matters on Retina-sized (3560×2220) captures where VT's internal
        // quality heuristic undershoots `-b:v` anyway. Fall back to H.264
        // if HEVC isn't available for any reason.
        HardwareEncoder::VideoToolboxHevc,
        HardwareEncoder::VideoToolboxH264,
        HardwareEncoder::Libx264Software,
        HardwareEncoder::Openh264Software,
    ][..];
    #[cfg(target_os = "windows")]
    let order = &[
        HardwareEncoder::NvencH264,
        HardwareEncoder::QsvH264,
        HardwareEncoder::AmfH264,
        HardwareEncoder::Libx264Software,
        HardwareEncoder::Openh264Software,
    ][..];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let order = &[
        HardwareEncoder::Libx264Software,
        HardwareEncoder::Openh264Software,
    ][..];

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExportPlatform {
    Macos,
    Windows,
    Other,
}

fn current_export_platform() -> ExportPlatform {
    #[cfg(target_os = "macos")]
    {
        ExportPlatform::Macos
    }
    #[cfg(target_os = "windows")]
    {
        ExportPlatform::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        ExportPlatform::Other
    }
}

fn export_h264_order(platform: ExportPlatform) -> &'static [HardwareEncoder] {
    match platform {
        ExportPlatform::Macos => &[
            HardwareEncoder::Libx264Software,
            HardwareEncoder::VideoToolboxH264,
            HardwareEncoder::Openh264Software,
        ],
        ExportPlatform::Windows => &[
            HardwareEncoder::NvencH264,
            HardwareEncoder::QsvH264,
            HardwareEncoder::AmfH264,
            HardwareEncoder::Libx264Software,
            HardwareEncoder::Openh264Software,
        ],
        ExportPlatform::Other => &[
            HardwareEncoder::Libx264Software,
            HardwareEncoder::Openh264Software,
        ],
    }
}

fn pick_export_h264_encoder_for_platform(
    probe: &EncoderProbe,
    platform: ExportPlatform,
) -> HardwareEncoder {
    export_h264_order(platform)
        .iter()
        .copied()
        .find(|encoder| probe.available.contains(encoder))
        .unwrap_or(probe.available[0])
}

/// Pick the default H.264 encoder for post-production MP4 export.
///
/// This intentionally differs from `EncoderProbe::preferred` on macOS:
/// recording may prefer HEVC, but current post-production MP4 export is
/// H.264-only unless a future feature adds explicit HEVC UI/container support.
pub fn pick_export_h264_encoder(probe: &EncoderProbe) -> HardwareEncoder {
    pick_export_h264_encoder_for_platform(probe, current_export_platform())
}

/// Pick the Phase 1 software fallback for MP4 export.
pub fn export_h264_software_fallback(
    probe: &EncoderProbe,
    primary: HardwareEncoder,
) -> Option<HardwareEncoder> {
    if primary.is_hardware() && probe.available.contains(&HardwareEncoder::Libx264Software) {
        Some(HardwareEncoder::Libx264Software)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_OUTPUT: &str = "\
Encoders:
 V..... = Video
 ------
 V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC encoder
 V..... libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC encoder
 V..... h264_videotoolbox    VideoToolbox H.264 Encoder
 V..... h264_nvenc           NVIDIA NVENC H.264 encoder
 A..... aac                  AAC (Advanced Audio Coding)
";

    #[test]
    fn parses_known_encoders() {
        let got = parse_encoders_output(SAMPLE_OUTPUT);
        assert!(got.contains(&HardwareEncoder::Libx264Software));
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
    fn preferred_falls_back_to_software_when_no_hw() {
        let avail = vec![HardwareEncoder::Libx264Software];
        assert_eq!(pick_preferred(&avail), HardwareEncoder::Libx264Software);
    }

    #[test]
    fn preferred_uses_openh264_when_it_is_only_software_encoder() {
        let avail = vec![HardwareEncoder::Openh264Software];
        assert_eq!(pick_preferred(&avail), HardwareEncoder::Openh264Software);
    }

    #[test]
    fn export_picker_macos_prefers_libx264_over_hardware() {
        let probe = EncoderProbe {
            available: vec![
                HardwareEncoder::VideoToolboxHevc,
                HardwareEncoder::VideoToolboxH264,
                HardwareEncoder::Libx264Software,
            ],
            preferred: HardwareEncoder::VideoToolboxHevc,
        };

        assert_eq!(
            pick_export_h264_encoder_for_platform(&probe, ExportPlatform::Macos),
            HardwareEncoder::Libx264Software
        );
    }

    #[test]
    fn export_picker_macos_falls_back_to_libx264() {
        let probe = EncoderProbe {
            available: vec![HardwareEncoder::Libx264Software],
            preferred: HardwareEncoder::Libx264Software,
        };

        assert_eq!(
            pick_export_h264_encoder_for_platform(&probe, ExportPlatform::Macos),
            HardwareEncoder::Libx264Software
        );
    }

    #[test]
    fn export_picker_windows_prefers_nvenc_then_qsv_then_amf() {
        let probe = EncoderProbe {
            available: vec![
                HardwareEncoder::AmfH264,
                HardwareEncoder::QsvH264,
                HardwareEncoder::NvencH264,
                HardwareEncoder::Libx264Software,
            ],
            preferred: HardwareEncoder::NvencH264,
        };

        assert_eq!(
            pick_export_h264_encoder_for_platform(&probe, ExportPlatform::Windows),
            HardwareEncoder::NvencH264
        );

        let probe = EncoderProbe {
            available: vec![
                HardwareEncoder::AmfH264,
                HardwareEncoder::QsvH264,
                HardwareEncoder::Libx264Software,
            ],
            preferred: HardwareEncoder::QsvH264,
        };

        assert_eq!(
            pick_export_h264_encoder_for_platform(&probe, ExportPlatform::Windows),
            HardwareEncoder::QsvH264
        );
    }

    #[test]
    fn export_picker_windows_falls_back_to_libx264() {
        let probe = EncoderProbe {
            available: vec![HardwareEncoder::Libx264Software],
            preferred: HardwareEncoder::Libx264Software,
        };

        assert_eq!(
            pick_export_h264_encoder_for_platform(&probe, ExportPlatform::Windows),
            HardwareEncoder::Libx264Software
        );
    }

    #[test]
    fn export_picker_other_platforms_use_software() {
        let probe = EncoderProbe {
            available: vec![
                HardwareEncoder::NvencH264,
                HardwareEncoder::Libx264Software,
                HardwareEncoder::Openh264Software,
            ],
            preferred: HardwareEncoder::NvencH264,
        };

        assert_eq!(
            pick_export_h264_encoder_for_platform(&probe, ExportPlatform::Other),
            HardwareEncoder::Libx264Software
        );
    }

    #[test]
    fn export_fallback_only_uses_libx264_for_hardware_primary() {
        let probe = EncoderProbe {
            available: vec![
                HardwareEncoder::VideoToolboxH264,
                HardwareEncoder::Libx264Software,
            ],
            preferred: HardwareEncoder::VideoToolboxH264,
        };

        assert_eq!(
            export_h264_software_fallback(&probe, HardwareEncoder::VideoToolboxH264),
            Some(HardwareEncoder::Libx264Software)
        );
        assert_eq!(
            export_h264_software_fallback(&probe, HardwareEncoder::Libx264Software),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preferred_picks_hevc_over_h264_on_mac() {
        let avail = vec![
            HardwareEncoder::VideoToolboxHevc,
            HardwareEncoder::VideoToolboxH264,
            HardwareEncoder::Libx264Software,
            HardwareEncoder::Openh264Software,
        ];
        assert_eq!(pick_preferred(&avail), HardwareEncoder::VideoToolboxHevc);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preferred_falls_back_to_h264_when_hevc_absent() {
        let avail = vec![
            HardwareEncoder::VideoToolboxH264,
            HardwareEncoder::Libx264Software,
            HardwareEncoder::Openh264Software,
        ];
        assert_eq!(pick_preferred(&avail), HardwareEncoder::VideoToolboxH264);
    }

    // ─── cache / force_reprobe tests ──────────────────────────────────

    use crate::sidecar::{SidecarChild, SidecarCommand};
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Mock sidecar that returns a canned `ffmpeg -encoders` stdout.
    struct MockCmd {
        calls: Arc<AtomicUsize>,
        payload: &'static str,
    }

    #[async_trait]
    impl SidecarCommand for MockCmd {
        async fn spawn(&self, _args: Vec<String>) -> Result<SidecarChild> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            // Pipe the payload through `cat` so the returned child has
            // real `tokio::process` stdio handles the probe can read.
            let mut cmd = tokio::process::Command::new("sh");
            cmd.arg("-c")
                .arg(format!("printf '%s' {}", shell_escape(self.payload)))
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = cmd
                .spawn()
                .map_err(|e| EncoderError::SpawnFailed(format!("mock spawn: {e}")))?;
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            Ok(SidecarChild {
                stdin,
                stdout,
                stderr,
                child,
            })
        }
    }

    fn shell_escape(s: &str) -> String {
        let mut out = String::from("'");
        for ch in s.chars() {
            if ch == '\'' {
                out.push_str("'\\''");
            } else {
                out.push(ch);
            }
        }
        out.push('\'');
        out
    }

    /// force_reprobe must bypass the cache and overwrite it so the next
    /// `probe_cached` observes the fresh value.
    #[tokio::test]
    async fn test_probe_force_reprobe() {
        // Seed with a sentinel value so probe_cached short-circuits.
        let sentinel = EncoderProbe {
            available: vec![HardwareEncoder::Openh264Software],
            preferred: HardwareEncoder::Openh264Software,
        };
        __test_set_cache(Some(sentinel.clone()));
        assert_eq!(
            __test_peek_cache().as_ref().map(|p| p.available.len()),
            Some(1)
        );

        // Fresh probe result: VideoToolbox + libx264 from a two-line
        // sample. force_reprobe must ignore the cache and replace it.
        let payload = "\
 V..... h264_videotoolbox    VideoToolbox H.264 Encoder
 V..... libx264              libx264 H.264 / AVC / MPEG-4 AVC encoder
";
        let calls = Arc::new(AtomicUsize::new(0));
        let cmd = MockCmd {
            calls: calls.clone(),
            payload,
        };

        let fresh = force_reprobe(&cmd).await.expect("force_reprobe");
        assert!(fresh.available.contains(&HardwareEncoder::Libx264Software));
        assert!(fresh.available.contains(&HardwareEncoder::VideoToolboxH264));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Cache now holds the fresh value, so a subsequent probe_cached
        // short-circuits without invoking the sidecar again.
        let cached = probe_cached(&cmd).await.expect("probe_cached");
        assert_eq!(cached.available, fresh.available);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "cache must short-circuit");

        // Reset for any other tests in this module.
        __test_set_cache(None);
    }
}

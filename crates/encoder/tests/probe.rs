//! Probe integration test — gated behind the `real-ffmpeg` feature so it
//! only runs when a real FFmpeg binary is available at
//! `scripts/build-ffmpeg/out/ffmpeg-<host-triple>`.

#![cfg(feature = "real-ffmpeg")]

include!("fixtures/ffmpeg_env.rs");

use encoder::{probe_encoders, HardwareEncoder, LocalFfmpegCommand};
use std::path::PathBuf;

#[tokio::test]
async fn probe_returns_nonempty() {
    let Some(path) = ffmpeg_path() else {
        eprintln!("skip: no ffmpeg binary at scripts/build-ffmpeg/out/ffmpeg-<triple>");
        return;
    };
    let cmd = LocalFfmpegCommand::new(path);
    let probe = probe_encoders(&cmd).await.expect("probe");
    assert!(!probe.available.is_empty(), "no encoders detected");
    // libx264 fallback should always be present in the bundled FFmpeg build.
    assert!(
        probe.available.contains(&HardwareEncoder::Openh264Software),
        "libx264 missing — bundled FFmpeg didn't include --enable-libx264"
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn probe_picks_videotoolbox_on_mac() {
    let Some(path) = ffmpeg_path() else {
        eprintln!("skip: no ffmpeg binary");
        return;
    };
    let cmd = LocalFfmpegCommand::new(path);
    let probe = probe_encoders(&cmd).await.expect("probe");
    // HEVC is preferred on macOS when present; H.264 wins only if HEVC is
    // absent.
    if probe.available.contains(&HardwareEncoder::VideoToolboxHevc) {
        assert_eq!(probe.preferred, HardwareEncoder::VideoToolboxHevc);
    } else if probe.available.contains(&HardwareEncoder::VideoToolboxH264) {
        assert_eq!(probe.preferred, HardwareEncoder::VideoToolboxH264);
    }
}

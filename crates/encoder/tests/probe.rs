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
    // libopenh264 fallback should always be present in the LGPL build.
    assert!(
        probe.available.contains(&HardwareEncoder::Openh264Software),
        "libopenh264 missing — LGPL build didn't include --enable-libopenh264"
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
    if probe.available.contains(&HardwareEncoder::VideoToolboxH264) {
        assert_eq!(probe.preferred, HardwareEncoder::VideoToolboxH264);
    }
}

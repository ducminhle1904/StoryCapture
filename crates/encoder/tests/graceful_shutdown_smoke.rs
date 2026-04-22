//! Graceful-shutdown smoke test (D-01): simulate mid-stream stop,
//! assert the resulting MP4 has a finalized `moov` atom so it plays
//! back cleanly. Gated behind `real-ffmpeg` — skips when the bundled
//! FFmpeg binary is absent.

#![cfg(feature = "real-ffmpeg")]

mod fixtures {
    include!("fixtures/synthetic.rs");
}

use encoder::{EncodeConfig, EncodePipeline, HardwareEncoder, LocalFfmpegCommand};
use std::path::PathBuf;
use std::process::Command;
use tokio::sync::mpsc;

fn host_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unknown"
    }
}

fn ffmpeg_path() -> Option<PathBuf> {
    let ws_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())?;
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let p = ws_root
        .join("scripts/build-ffmpeg/out")
        .join(format!("ffmpeg-{}{ext}", host_triple()));
    p.exists().then_some(p)
}

fn ffprobe_path(ffmpeg: &PathBuf) -> Option<PathBuf> {
    let dir = ffmpeg.parent()?;
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let candidate = dir.join(format!("ffprobe-{}{ext}", host_triple()));
    candidate.exists().then_some(candidate)
}

/// D-01 smoke: half-second of synthetic frames then graceful shutdown
/// (drop frame_tx). Output MP4 must have a `moov` atom.
#[tokio::test]
async fn test_graceful_shutdown_finalizes_moov() {
    let Some(ffmpeg) = ffmpeg_path() else {
        eprintln!("skip: no ffmpeg binary");
        return;
    };
    let cmd = LocalFfmpegCommand::new(ffmpeg.clone());
    let tmp = tempfile::tempdir().unwrap();
    let out_path = tmp.path().join("graceful.mp4");

    let cfg = EncodeConfig::new(
        out_path.clone(),
        320,
        240,
        30,
        HardwareEncoder::Openh264Software,
    );

    let (frame_tx, frame_rx) = mpsc::channel(8);
    let (prog_tx, mut prog_rx) = mpsc::channel(16);

    let join = EncodePipeline::start(cfg, &cmd, frame_rx, prog_tx)
        .await
        .expect("pipeline start");

    tokio::spawn(async move { while prog_rx.recv().await.is_some() {} });

    // ~0.5s of frames, then graceful EOF via drop.
    let frames = fixtures::generate_synthetic_frames(320, 240, 30, 1);
    for f in frames.into_iter().take(15) {
        frame_tx.send(f).await.unwrap();
    }
    drop(frame_tx);

    let result = join
        .await
        .expect("join")
        .expect("encode finalized cleanly");
    assert!(out_path.exists(), "output missing");
    assert!(result.frames_written >= 10);

    // Probe for moov atom. Prefer sibling ffprobe; otherwise use FFmpeg's
    // -f null null output which re-muxes and fails on a missing moov.
    if let Some(ffprobe) = ffprobe_path(&ffmpeg) {
        let out = Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "default=nw=1",
            ])
            .arg(&out_path)
            .output()
            .expect("ffprobe spawn");
        assert!(
            out.status.success(),
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("video"),
            "ffprobe output missing video stream: {stdout}"
        );
    } else {
        let out = Command::new(&ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(&out_path)
            .args(["-f", "null", "-"])
            .output()
            .expect("ffmpeg remux spawn");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            out.status.success(),
            "ffmpeg remux failed (moov likely missing): {stderr}"
        );
        assert!(
            !stderr.to_lowercase().contains("moov atom not found"),
            "moov atom missing: {stderr}"
        );
    }
}

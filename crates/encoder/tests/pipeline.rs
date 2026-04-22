//! Pipeline integration test — gated behind `real-ffmpeg`. Generates
//! synthetic BGRA frames, pipes them into FFmpeg, asserts the output
//! MP4 exists and has non-zero size.

#![cfg(feature = "real-ffmpeg")]

mod fixtures {
    include!("fixtures/synthetic.rs");
}
include!("fixtures/ffmpeg_env.rs");

use encoder::{EncodeConfig, EncodePipeline, EncoderError, HardwareEncoder, LocalFfmpegCommand};
use std::path::PathBuf;
use tokio::sync::mpsc;

#[tokio::test]
async fn synthetic_five_second_encode() {
    let Some(path) = ffmpeg_path() else {
        eprintln!("skip: no ffmpeg binary");
        return;
    };
    let cmd = LocalFfmpegCommand::new(path);
    let tmp = tempfile::tempdir().unwrap();
    let out_path = tmp.path().join("out.mp4");

    let cfg = EncodeConfig::new(
        out_path.clone(),
        640,
        360,
        30,
        HardwareEncoder::Openh264Software,
    );

    let (frame_tx, frame_rx) = mpsc::channel(8);
    let (prog_tx, mut prog_rx) = mpsc::channel(16);

    // Kick encode in background.
    let join = EncodePipeline::start(cfg, &cmd, frame_rx, prog_tx)
        .await
        .expect("pipeline start");

    // Drain progress in the background so the stderr pipe doesn't fill.
    tokio::spawn(async move { while prog_rx.recv().await.is_some() {} });

    let frames = fixtures::generate_synthetic_frames(640, 360, 30, 5);
    for f in frames {
        frame_tx.send(f).await.unwrap();
    }
    drop(frame_tx); // EOF

    let result = join.await.expect("join").expect("encode ok");
    assert!(
        result.frames_written >= 150,
        "too few frames written: {}",
        result.frames_written
    );
    assert!(out_path.exists(), "output file missing");
    let size = std::fs::metadata(&out_path).unwrap().len();
    assert!(size > 1024, "output too small: {size} bytes");
}

#[tokio::test]
async fn stderr_tail_on_invalid_arg() {
    let Some(path) = ffmpeg_path() else {
        eprintln!("skip: no ffmpeg binary");
        return;
    };
    let cmd = LocalFfmpegCommand::new(path);
    let tmp = tempfile::tempdir().unwrap();
    let out_path = tmp.path().join("out.mp4");

    // Zero fps → invalid; config validate rejects before spawn.
    let mut cfg = EncodeConfig::new(out_path, 640, 360, 30, HardwareEncoder::Openh264Software);
    cfg.fps_advisory = 0;

    let (_tx, rx) = mpsc::channel(1);
    let (ptx, _prx) = mpsc::channel(1);
    let err = EncodePipeline::start(cfg, &cmd, rx, ptx).await.err();
    assert!(matches!(err, Some(EncoderError::InvalidConfig(_))));
}

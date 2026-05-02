//! Integration tests for the smart-batch fan-out pipeline.
//! These tests exercise the argv shape of the FFV1 intermediate
//! and per-format encoder calls via a scripted `SidecarCommand` mock —
//! they never spawn a real FFmpeg.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use encoder::{
    build_encode_args, build_intermediate_args, fanout_encode, FanoutPlan, HardwareEncoder,
    IntermediateOutput, OutputFormat, OutputSpec, Quality, Resolution, Result as EncoderResult,
};
use encoder::{EncoderError, SidecarChild, SidecarCommand};

struct RecordingCmd {
    calls: Arc<Mutex<Vec<Vec<String>>>>,
}

#[async_trait]
impl SidecarCommand for RecordingCmd {
    async fn spawn(&self, args: Vec<String>) -> EncoderResult<SidecarChild> {
        self.calls.lock().unwrap().push(args);
        #[cfg(unix)]
        let mut cmd = tokio::process::Command::new("true");
        #[cfg(windows)]
        let mut cmd = {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/c").arg("exit 0");
            c
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| EncoderError::SpawnFailed(e.to_string()))?;
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

#[test]
fn intermediate_ffv1_flags() {
    let args = build_intermediate_args(
        "[0:v]null[out_v];[0:a]anull[out_a]".into(),
        &[vec!["-i".into(), "/tmp/in.mp4".into()]],
        Path::new("/tmp/interm.mkv"),
        60_000,
    );
    let joined = args.join(" ");
    assert!(joined.contains("-c:v ffv1"));
    assert!(joined.contains("-level 3"));
    assert!(joined.contains("-coder 1"));
    assert!(joined.contains("-context 1"));
    assert!(joined.contains("-g 1"));
    assert!(joined.contains("-slicecrc 1"));
    assert!(joined.contains("-slices 24"));
    assert!(joined.contains("-pix_fmt yuv420p"));
    assert!(joined.contains("-c:a pcm_s16le"));
}

#[test]
fn intermediate_omits_missing_audio_filter_label() {
    let args = build_intermediate_args(
        "[0:v]null[out_v]".into(),
        &[vec!["-i".into(), "/tmp/in.mp4".into()]],
        Path::new("/tmp/interm.mkv"),
        60_000,
    );
    let joined = args.join(" ");
    assert!(joined.contains("-map [out_v]"), "args={joined}");
    assert!(!joined.contains("[out_a]"), "args={joined}");
    assert!(!joined.contains("-c:a"), "args={joined}");
}

#[test]
fn fanout_plan_mp4_webm() {
    let plan = FanoutPlan::batch(
        vec![OutputFormat::Mp4, OutputFormat::WebM],
        Resolution::R1080p,
        60,
        Quality::Med,
        Path::new("/tmp"),
        "clip",
    );
    assert_eq!(plan.outputs.len(), 2);
    let mp4 = build_encode_args(
        Path::new("/tmp/interm.mkv"),
        &plan.outputs[0],
        HardwareEncoder::VideoToolboxH264,
    );
    assert!(mp4.iter().any(|a| a == "h264_videotoolbox"));
    assert!(mp4.iter().any(|a| a == "+faststart"));
    let webm = build_encode_args(
        Path::new("/tmp/interm.mkv"),
        &plan.outputs[1],
        HardwareEncoder::Libx264Software,
    );
    assert!(webm.iter().any(|a| a == "libvpx-vp9"));
    assert!(webm.iter().any(|a| a == "libopus"));
}

#[test]
fn gif_uses_palettegen_and_paletteuse() {
    let spec = OutputSpec {
        format: OutputFormat::Gif,
        resolution: Resolution::R720p,
        fps: 24,
        quality: Quality::Med,
        output_path: PathBuf::from("/tmp/clip.gif"),
    };
    let args = build_encode_args(
        Path::new("/tmp/interm.mkv"),
        &spec,
        HardwareEncoder::Libx264Software,
    );
    let joined = args.join(" ");
    assert!(joined.contains("palettegen"), "args={joined}");
    assert!(joined.contains("paletteuse"), "args={joined}");
    // Pitfall #7: dither=bayer keeps GIF sizes manageable.
    assert!(joined.contains("dither=bayer"));
}

#[tokio::test]
async fn multi_encode_parallel_spawns_two_sidecars() {
    let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
    let intermediate = IntermediateOutput {
        path: PathBuf::from("/tmp/interm.mkv"),
        duration_ms: 60_000,
        width: 1920,
        height: 1080,
        fps: 60,
    };
    let plan = FanoutPlan::batch(
        vec![OutputFormat::Mp4, OutputFormat::WebM],
        Resolution::R1080p,
        60,
        Quality::Med,
        Path::new("/tmp"),
        "clip",
    );
    let calls_c = calls.clone();
    let outs = fanout_encode(
        &intermediate,
        &plan,
        move || {
            Arc::new(RecordingCmd {
                calls: calls_c.clone(),
            }) as Arc<dyn SidecarCommand>
        },
        HardwareEncoder::Libx264Software,
    )
    .await
    .unwrap();
    assert_eq!(outs.len(), 2);
    let recorded = calls.lock().unwrap();
    assert_eq!(recorded.len(), 2);
}

#[test]
fn bitrate_scales_with_quality() {
    // Sanity: High > Med > Low for the same codec + resolution.
    use encoder::bitrate_for;
    let low = bitrate_for(Resolution::R1080p, Quality::Low, "h264");
    let med = bitrate_for(Resolution::R1080p, Quality::Med, "h264");
    let hi = bitrate_for(Resolution::R1080p, Quality::High, "h264");
    fn kbit(s: &str) -> u32 {
        s.trim_end_matches('k').parse::<u32>().unwrap()
    }
    assert!(kbit(&low) < kbit(&med));
    assert!(kbit(&med) < kbit(&hi));
}

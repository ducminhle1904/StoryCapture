//! Resolution-lock end-to-end guard. Spawns the real FFmpeg sidecar,
//! encodes solid-color BGRA frames, and asserts ffprobe-reported output dims
//! match the requested preset EXACTLY. Also samples pad-region pixels to
//! catch regressions in `PadColor` wiring.
//!
//! Gated behind `real-ffmpeg`; skips cleanly if the sidecar binary is absent.

#![cfg(feature = "real-ffmpeg")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use capture::{ClockSource, Frame, FrameData, PixelFormat, Pts};
use encoder::{
    EncodeConfig, EncodePipeline, FitMode, HardwareEncoder, LocalFfmpegCommand, OutputResolution,
    PadColor, ScaleAlgo,
};
use tokio::sync::mpsc;
use tokio::time::timeout;

const FPS: u32 = 30;
const FRAME_COUNT: u32 = 30;
const ENCODE_BUDGET: Duration = Duration::from_secs(60);

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

fn exe_suffix() -> &'static str {
    if cfg!(windows) { ".exe" } else { "" }
}

fn workspace_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
}

fn sidecar_binary(name: &str) -> Option<PathBuf> {
    let ws = workspace_root()?;
    let p = ws
        .join("scripts/build-ffmpeg/out")
        .join(format!("{name}-{}{}", host_triple(), exe_suffix()));
    if p.exists() { Some(p) } else { None }
}

fn path_lookup(name: &str) -> Option<PathBuf> {
    let filename = format!("{name}{}", exe_suffix());
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(&filename);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn env_override(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.exists())
}

fn resolve_ffmpeg() -> Option<PathBuf> {
    env_override("STORYCAPTURE_FFMPEG_BIN")
        .or_else(|| sidecar_binary("ffmpeg"))
        .or_else(|| path_lookup("ffmpeg"))
}

fn resolve_ffprobe() -> Option<PathBuf> {
    env_override("STORYCAPTURE_FFPROBE_BIN")
        .or_else(|| sidecar_binary("ffprobe"))
        .or_else(|| path_lookup("ffprobe"))
}

struct Tools {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

fn tools_or_skip(test_name: &str) -> Option<Tools> {
    let Some(ffmpeg) = resolve_ffmpeg() else {
        eprintln!("skip: {test_name}: ffmpeg not resolvable");
        return None;
    };
    let Some(ffprobe) = resolve_ffprobe() else {
        eprintln!("skip: {test_name}: ffprobe not resolvable");
        return None;
    };
    Some(Tools { ffmpeg, ffprobe })
}

fn solid_bgra(w: u32, h: u32, b: u8, g: u8, r: u8) -> Vec<u8> {
    let len = (w as usize) * (h as usize) * 4;
    let mut buf = Vec::with_capacity(len);
    for _ in 0..(w as usize * h as usize) {
        buf.push(b);
        buf.push(g);
        buf.push(r);
        buf.push(0xFF);
    }
    buf
}

fn frame_n(width: u32, height: u32, bgra: &[u8], i: u32) -> Frame {
    let ns_per_frame = 1_000_000_000i128 / FPS as i128;
    let stride = (width * 4) as usize;
    Frame {
        pts: Pts {
            ns: i as i128 * ns_per_frame,
            source: ClockSource::Synthetic,
        },
        width_px: width,
        height_px: height,
        format: PixelFormat::Bgra,
        data: FrameData::Owned(bgra.to_vec(), stride),
        sequence: i as u64,
    }
}

fn ffprobe_dims(ffprobe: &Path, mp4: &Path) -> (u32, u32) {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(mp4)
        .output()
        .expect("ffprobe spawn");
    assert!(
        out.status.success(),
        "ffprobe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next().unwrap_or("").trim();
    let mut it = line.split(',');
    let w: u32 = it
        .next()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or_else(|| panic!("ffprobe bad width in {line:?}"));
    let h: u32 = it
        .next()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or_else(|| panic!("ffprobe bad height in {line:?}"));
    (w, h)
}

/// Extract the middle frame of `mp4` to a PNG via ffmpeg, then decode it.
fn extract_middle_frame_rgb(ffmpeg: &Path, mp4: &Path, tmp_dir: &Path) -> image::RgbImage {
    let png_path = tmp_dir.join("frame.png");
    let status = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-ss", "00:00:00.4", "-i"])
        .arg(mp4)
        .args(["-frames:v", "1", "-f", "image2", "-c:v", "png"])
        .arg(&png_path)
        .status()
        .expect("ffmpeg extract spawn");
    assert!(status.success(), "ffmpeg frame extract failed");
    image::open(&png_path)
        .expect("decode png")
        .to_rgb8()
}

fn sample(img: &image::RgbImage, x: u32, y: u32) -> (u8, u8, u8) {
    let p = img.get_pixel(x, y);
    (p.0[0], p.0[1], p.0[2])
}

fn near(got: (u8, u8, u8), want: (u8, u8, u8), tol: i16) -> bool {
    let dr = (got.0 as i16 - want.0 as i16).abs();
    let dg = (got.1 as i16 - want.1 as i16).abs();
    let db = (got.2 as i16 - want.2 as i16).abs();
    dr <= tol && dg <= tol && db <= tol
}

async fn encode_solid_color(
    ffmpeg: &Path,
    cfg: EncodeConfig,
    capture_w: u32,
    capture_h: u32,
    bgra: Vec<u8>,
) {
    let cmd = LocalFfmpegCommand::new(ffmpeg.to_path_buf());
    let (frame_tx, frame_rx) = mpsc::channel::<Frame>(8);
    let (prog_tx, mut prog_rx) = mpsc::channel(32);
    tokio::spawn(async move { while prog_rx.recv().await.is_some() {} });

    let join = EncodePipeline::start(cfg, &cmd, frame_rx, prog_tx)
        .await
        .expect("pipeline start");

    for i in 0..FRAME_COUNT {
        let f = frame_n(capture_w, capture_h, &bgra, i);
        frame_tx.send(f).await.expect("send frame");
    }
    drop(frame_tx);

    let result = timeout(ENCODE_BUDGET, join)
        .await
        .expect("encode within budget")
        .expect("join")
        .expect("encode ok");
    assert!(result.bytes > 1024, "output too small: {}", result.bytes);
}

fn base_cfg(out: &Path, capture_w: u32, capture_h: u32) -> EncodeConfig {
    EncodeConfig::new(
        out.to_path_buf(),
        capture_w,
        capture_h,
        FPS,
        HardwareEncoder::Openh264Software,
    )
}

/// Bug repro: 1920x1130 capture, preset P1080 → MUST produce 1920x1080.
#[tokio::test]
async fn test_letterbox_1920x1130_to_p1080() {
    let Some(t) = tools_or_skip("test_letterbox_1920x1130_to_p1080") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out.mp4");
    let cfg = base_cfg(&out, 1920, 1130)
        .with_output_resolution(OutputResolution::P1080)
        .unwrap()
        .with_fit_mode(FitMode::Letterbox)
        .with_pad_color(PadColor::Black)
        .with_scale_algo(ScaleAlgo::Lanczos);
    let bgra = solid_bgra(1920, 1130, 0x00, 0x00, 0xFF);
    encode_solid_color(&t.ffmpeg, cfg, 1920, 1130, bgra).await;
    assert_eq!(ffprobe_dims(&t.ffprobe, &out), (1920, 1080));
}

/// Source smaller than preset must NOT upscale; pad corner is black.
#[tokio::test]
async fn test_no_upscale_800x600_to_p1080() {
    let Some(t) = tools_or_skip("test_no_upscale_800x600_to_p1080") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out.mp4");
    let cfg = base_cfg(&out, 800, 600)
        .with_output_resolution(OutputResolution::P1080)
        .unwrap()
        .with_fit_mode(FitMode::Letterbox)
        .with_pad_color(PadColor::Black);
    let bgra = solid_bgra(800, 600, 0x00, 0x00, 0xFF);
    encode_solid_color(&t.ffmpeg, cfg, 800, 600, bgra).await;
    assert_eq!(ffprobe_dims(&t.ffprobe, &out), (1920, 1080));

    let img = extract_middle_frame_rgb(&t.ffmpeg, &out, tmp.path());
    // Corner (10, 10) is pad, not content, since the scaled 800x600 (~1440x1080)
    // is centered → pad columns on left and right.
    assert!(
        near(sample(&img, 10, 10), (0, 0, 0), 10),
        "top-left pad pixel not black: {:?}",
        sample(&img, 10, 10)
    );
}

/// 2560x1440 → P2160 pillarbox (wider aspect becomes narrower? actually
/// 16:9 → 16:9, scales cleanly). Use 2000x1440 to force pillarbox.
#[tokio::test]
async fn test_2000x1440_to_p2160_pillarbox() {
    let Some(t) = tools_or_skip("test_2000x1440_to_p2160_pillarbox") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out.mp4");
    let cfg = base_cfg(&out, 2000, 1440)
        .with_output_resolution(OutputResolution::P2160)
        .unwrap()
        .with_fit_mode(FitMode::Letterbox)
        .with_pad_color(PadColor::Black);
    let bgra = solid_bgra(2000, 1440, 0x00, 0x00, 0xFF);
    encode_solid_color(&t.ffmpeg, cfg, 2000, 1440, bgra).await;
    assert_eq!(ffprobe_dims(&t.ffprobe, &out), (3840, 2160));
}

/// MatchSource rounds odd dims down to even via bitwise floor.
#[tokio::test]
async fn test_matchsource_rounding_1923x1081_to_even() {
    let Some(t) = tools_or_skip("test_matchsource_rounding_1923x1081_to_even") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out.mp4");
    let cfg = base_cfg(&out, 1923, 1081)
        .with_output_resolution(OutputResolution::MatchSource)
        .unwrap()
        .with_fit_mode(FitMode::Letterbox);
    let bgra = solid_bgra(1923, 1081, 0x40, 0x80, 0x20);
    encode_solid_color(&t.ffmpeg, cfg, 1923, 1081, bgra).await;
    assert_eq!(ffprobe_dims(&t.ffprobe, &out), (1922, 1080));
}

/// 16:9 source at higher res → P1080 scales cleanly, no pad.
#[tokio::test]
async fn test_perfect_aspect_3840x2160_to_p1080_no_pad() {
    let Some(t) = tools_or_skip("test_perfect_aspect_3840x2160_to_p1080_no_pad") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out.mp4");
    let cfg = base_cfg(&out, 3840, 2160)
        .with_output_resolution(OutputResolution::P1080)
        .unwrap()
        .with_fit_mode(FitMode::Letterbox)
        .with_pad_color(PadColor::Black);
    let content = (0x20u8, 0x60u8, 0xC0u8); // B,G,R → R=0xC0 G=0x60 B=0x20
    let bgra = solid_bgra(3840, 2160, content.0, content.1, content.2);
    encode_solid_color(&t.ffmpeg, cfg, 3840, 2160, bgra).await;
    assert_eq!(ffprobe_dims(&t.ffprobe, &out), (1920, 1080));

    let img = extract_middle_frame_rgb(&t.ffmpeg, &out, tmp.path());
    // 16:9 → 16:9 scales to full frame; corner (4,4) is content (R,G,B).
    let px = sample(&img, 4, 4);
    let want = (content.2, content.1, content.0);
    assert!(
        near(px, want, 10),
        "corner should be content color {:?}, got {:?}",
        want,
        px
    );
}

/// White pad color applied in the pad region.
#[tokio::test]
async fn test_white_pad_color_sampled_in_region() {
    let Some(t) = tools_or_skip("test_white_pad_color_sampled_in_region") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out.mp4");
    let cfg = base_cfg(&out, 800, 600)
        .with_output_resolution(OutputResolution::P1080)
        .unwrap()
        .with_fit_mode(FitMode::Letterbox)
        .with_pad_color(PadColor::White);
    let bgra = solid_bgra(800, 600, 0x00, 0x00, 0xFF);
    encode_solid_color(&t.ffmpeg, cfg, 800, 600, bgra).await;
    assert_eq!(ffprobe_dims(&t.ffprobe, &out), (1920, 1080));

    let img = extract_middle_frame_rgb(&t.ffmpeg, &out, tmp.path());
    let px = sample(&img, 5, 5);
    assert!(
        near(px, (255, 255, 255), 10),
        "pad pixel not white: {:?}",
        px
    );
}

/// Custom pad color hex applied and sampled.
#[tokio::test]
async fn test_custom_pad_color_hex_applied() {
    let Some(t) = tools_or_skip("test_custom_pad_color_hex_applied") else {
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let out = tmp.path().join("out.mp4");
    let cfg = base_cfg(&out, 800, 600)
        .with_output_resolution(OutputResolution::P1080)
        .unwrap()
        .with_fit_mode(FitMode::Letterbox)
        .with_pad_color(PadColor::Custom {
            r: 255,
            g: 0,
            b: 128,
        });
    let bgra = solid_bgra(800, 600, 0xFF, 0xFF, 0xFF);
    encode_solid_color(&t.ffmpeg, cfg, 800, 600, bgra).await;
    assert_eq!(ffprobe_dims(&t.ffprobe, &out), (1920, 1080));

    let img = extract_middle_frame_rgb(&t.ffmpeg, &out, tmp.path());
    let (r, g, b) = sample(&img, 5, 5);
    assert!(r > 230, "pad R should be ~255, got {r}");
    assert!(g < 25, "pad G should be ~0, got {g}");
    assert!(
        (110..=145).contains(&b),
        "pad B should be ~128, got {b}"
    );
}

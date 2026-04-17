//! `EncodeConfig` — inputs to the FFmpeg sidecar for a single recording.
//!
//! Phase 1 is MP4 / H.264 baseline only (D-25). Resolution + framerate
//! come from the capture source; audio is a silent 48 kHz mono AAC track
//! so downstream Phase 2 features (which assume both streams) have
//! something to mix — and so the A/V drift CI job (D-26 / ENC-05) is
//! meaningful.

use std::path::PathBuf;

use crate::error::{EncoderError, Result};
use crate::probe::HardwareEncoder;

#[derive(Debug, Clone)]
pub struct EncodeConfig {
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    /// FPS *advisory* — FFmpeg receives this hint but the `-vsync vfr`
    /// flag preserves per-frame PTS from the capture API (D-21). Actual
    /// framerate is VFR driven by the incoming capture timestamps.
    pub fps_advisory: u32,
    pub encoder: HardwareEncoder,
    /// Video bitrate in kbps. Default: 12_000.
    pub bitrate_kbps: u32,
}

impl EncodeConfig {
    pub fn new(
        output_path: PathBuf,
        width: u32,
        height: u32,
        fps_advisory: u32,
        encoder: HardwareEncoder,
    ) -> Self {
        EncodeConfig {
            output_path,
            width,
            height,
            fps_advisory,
            encoder,
            bitrate_kbps: 12_000,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.width == 0 || self.height == 0 {
            return Err(EncoderError::InvalidConfig(format!(
                "zero dimension: {}x{}",
                self.width, self.height
            )));
        }
        if self.fps_advisory == 0 {
            return Err(EncoderError::InvalidConfig("fps_advisory must be > 0".into()));
        }
        if self
            .output_path
            .as_os_str()
            .is_empty()
        {
            return Err(EncoderError::InvalidConfig("empty output_path".into()));
        }
        Ok(())
    }

    /// Render the full FFmpeg argv (minus the binary path itself). See
    /// plan 01-08 for the canonical form.
    ///
    /// Key flags:
    ///   - `-f rawvideo -pix_fmt bgra -s WxH -r FPS -i pipe:0` — raw BGRA
    ///     frames arrive on stdin at the advisory rate.
    ///   - `-f lavfi -i anullsrc=r=48000:cl=mono` — silent audio track so
    ///     the MP4 always has two streams.
    ///   - `-c:v <encoder> -b:v 12M -profile:v baseline -level 4.1
    ///     -pix_fmt yuv420p` — H.264 baseline, widely-compatible output.
    ///   - `-vsync vfr` — preserve capture-API per-frame PTS (D-21).
    ///   - `-movflags +faststart` — MP4 moov atom at the head of the file
    ///     so the web companion (Phase 4) can stream without a full
    ///     download.
    ///   - `-progress pipe:2 -loglevel info` — progress events on stderr
    ///     (`pipe:2`) are parsed by `progress.rs`.
    pub fn to_ffmpeg_args(&self) -> Vec<String> {
        // Bitrate scales with pixel count — 12 Mbps is fine for 1080p but
        // looks washed out at 4K. Compute ~0.10 bpp target, clamped.
        let pixels = (self.width as u64) * (self.height as u64);
        let target_kbps = ((pixels / 1000) as u32).clamp(self.bitrate_kbps, 40_000);
        let bitrate = format!("{}k", target_kbps);
        // H.264 requires even dimensions. We keep native resolution (no
        // downscale) now that the `-profile:v baseline -level 4.1`
        // constraint is gone — VideoToolbox on Apple Silicon happily
        // handles 4K inputs. Scale filter just rounds to even dims.
        let scale_filter = "scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string();
        vec![
            "-hide_banner".into(),
            "-y".into(),
            // --- raw BGRA input on stdin ---
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "bgra".into(),
            "-s".into(),
            format!("{}x{}", self.width, self.height),
            "-r".into(),
            self.fps_advisory.to_string(),
            "-use_wallclock_as_timestamps".into(),
            "0".into(),
            "-i".into(),
            "pipe:0".into(),
            // --- silent audio ---
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "anullsrc=r=48000:cl=mono".into(),
            // --- downscale + even-dim video filter ---
            "-vf".into(),
            scale_filter,
            // --- video encode ---
            // NOTE: no explicit -profile/-level — VideoToolbox rejects
            // baseline@4.1 for frames exceeding its macroblock budget
            // (>8192 MBs). Letting FFmpeg pick defaults keeps encodes
            // compatible across capture dimensions.
            "-c:v".into(),
            self.encoder.ffmpeg_codec_name().into(),
            "-b:v".into(),
            bitrate,
            "-pix_fmt".into(),
            "yuv420p".into(),
            // --- audio encode ---
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "64k".into(),
            // --- framing / packaging ---
            "-fps_mode".into(),
            "vfr".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-shortest".into(),
            // --- progress + logs ---
            "-progress".into(),
            "pipe:2".into(),
            "-loglevel".into(),
            "info".into(),
            // --- output ---
            self.output_path.display().to_string(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cfg() -> EncodeConfig {
        EncodeConfig::new(
            PathBuf::from("/tmp/out.mp4"),
            1280,
            720,
            30,
            HardwareEncoder::Openh264Software,
        )
    }

    #[test]
    fn ffmpeg_args_contain_required_flags() {
        let args = cfg().to_ffmpeg_args().join(" ");
        assert!(args.contains("-progress pipe:2"), "progress flag missing: {args}");
        assert!(args.contains("-fps_mode vfr"), "fps_mode vfr missing: {args}");
        assert!(args.contains("-movflags +faststart"), "faststart missing: {args}");
        assert!(args.contains("-pix_fmt bgra"), "pix_fmt bgra missing: {args}");
        assert!(args.contains("-f rawvideo"), "rawvideo missing: {args}");
        assert!(args.contains("pipe:0"), "stdin input missing: {args}");
        assert!(args.contains("anullsrc"), "silent audio missing: {args}");
        assert!(args.contains("libopenh264"), "encoder name missing: {args}");
        assert!(args.contains("1280x720"), "resolution missing: {args}");
    }

    #[test]
    fn validate_rejects_zero_dims() {
        let mut c = cfg();
        c.width = 0;
        assert!(c.validate().is_err());
    }
}

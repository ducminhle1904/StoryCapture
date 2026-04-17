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

/// Raw-PCM sample format for the mic audio fifo input (Phase 6 plan 01).
/// v1 always uses F32LE — cpal hands us `f32` and we `bytemuck::cast_slice`
/// straight to the pipe. S16LE is reserved for a future low-bandwidth
/// mic mode but not currently produced.
#[derive(Debug, Clone, Copy)]
pub enum AudioFormat {
    F32LE,
    S16LE,
}

impl AudioFormat {
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            AudioFormat::F32LE => "f32le",
            AudioFormat::S16LE => "s16le",
        }
    }
}

/// Mic audio input for the encoder (Phase 6 plan 01, D-03).
///
/// When set, FFmpeg reads raw PCM from `fifo_path` as input 1; the video
/// stdin path stays on `pipe:0` (input 0). When unset, the existing
/// silent `anullsrc` track is retained (D-25 / Phase 1 behavior).
#[derive(Debug, Clone)]
pub struct AudioInput {
    pub fifo_path: PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: AudioFormat,
}

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
    /// Optional mic audio input. `None` → silent anullsrc track
    /// (backwards-compatible Phase 1 behavior).
    pub audio_input: Option<AudioInput>,
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
            audio_input: None,
        }
    }

    /// Attach a mic audio input. Called by the host pipeline once the
    /// fifo is ready and FFmpeg has been spawned with the dual-input arg
    /// shape (see `to_ffmpeg_args`).
    pub fn with_audio(mut self, audio: AudioInput) -> Self {
        self.audio_input = Some(audio);
        self
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

        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-y".into(),
            // --- raw BGRA input on stdin (input 0) ---
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
        ];

        // --- audio input (input 1) ---
        // Phase 6 plan 01: when audio_input is Some, FFmpeg reads raw PCM
        // from the named pipe. When None, the original anullsrc silent
        // track is retained byte-for-byte — this branch is the regression
        // guard for the no-audio path.
        match &self.audio_input {
            Some(audio) => {
                args.extend([
                    "-f".into(),
                    audio.format.ffmpeg_name().into(),
                    "-ar".into(),
                    audio.sample_rate.to_string(),
                    "-ac".into(),
                    audio.channels.to_string(),
                    "-i".into(),
                    audio.fifo_path.display().to_string(),
                ]);
            }
            None => {
                args.extend([
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    "anullsrc=r=48000:cl=mono".into(),
                ]);
            }
        }

        // --- stream mapping (explicit only when real audio is in use) ---
        // The silent-audio path omits -map and relies on FFmpeg's default
        // "pick best of each type" — preserves Phase 1's byte-for-byte
        // arg shape for regression stability.
        if self.audio_input.is_some() {
            args.extend([
                "-map".into(),
                "0:v:0".into(),
                "-map".into(),
                "1:a:0".into(),
            ]);
        }

        args.extend([
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
        ]);

        // Phase 6 plan 01 decision: mic path upgrades to 128 kbps stereo
        // (Claude's discretion in 06-CONTEXT — standard for voiceover).
        // Silent path keeps the existing 64 kbps so no-audio recordings
        // don't grow for no reason.
        if self.audio_input.is_some() {
            args.extend([
                "-b:a".into(),
                "128k".into(),
                "-ac".into(),
                "2".into(),
            ]);
        } else {
            args.extend(["-b:a".into(), "64k".into()]);
        }

        args.extend([
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
        ]);

        args
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

    // ──────────────────────────────────────────────────────────────
    // Phase 6 plan 01 — audio dual-input arg shape.
    // ──────────────────────────────────────────────────────────────

    /// Regression guard: the no-audio path must stay byte-identical to
    /// Phase 1's shape. A diff here means the silent-audio pipeline
    /// behavior has changed and downstream (Phase 2 mux, web companion)
    /// may be affected.
    #[test]
    fn audio_none_path_preserves_phase1_args() {
        let args = cfg().to_ffmpeg_args().join(" ");
        assert!(args.contains("-f lavfi -i anullsrc=r=48000:cl=mono"));
        assert!(args.contains("-b:a 64k"));
        // No explicit -map in the silent path (FFmpeg picks defaults).
        assert!(
            !args.contains("-map"),
            "silent-audio path must not add explicit stream mapping: {args}"
        );
        // The 128k audio bitrate is the mic-path default, not the
        // silent-path default.
        assert!(!args.contains("-b:a 128k"));
    }

    #[test]
    fn audio_some_path_adds_fifo_input_and_mapping() {
        let mut c = cfg();
        c.audio_input = Some(AudioInput {
            fifo_path: PathBuf::from("/tmp/mic.fifo"),
            sample_rate: 48_000,
            channels: 1,
            format: AudioFormat::F32LE,
        });
        let args = c.to_ffmpeg_args().join(" ");
        // Raw PCM input follows the video input (order matters — FFmpeg
        // attaches -f/-ar/-ac to the NEXT -i).
        assert!(args.contains("-f f32le"), "missing -f f32le: {args}");
        assert!(args.contains("-ar 48000"), "missing -ar 48000: {args}");
        assert!(args.contains("-ac 1"), "missing -ac 1 for mono mic: {args}");
        assert!(args.contains("-i /tmp/mic.fifo"), "missing fifo -i: {args}");
        // Explicit mapping so FFmpeg picks the fifo audio (input 1) and
        // NOT the silent anullsrc (which isn't generated on this path).
        assert!(args.contains("-map 0:v:0 -map 1:a:0"), "missing maps: {args}");
        // AAC 128 kbps stereo output — mic path default per plan.
        assert!(args.contains("-b:a 128k"), "missing 128k audio: {args}");
        assert!(args.contains("-ac 2"), "missing stereo downmix: {args}");
        // anullsrc must be absent on the mic path.
        assert!(!args.contains("anullsrc"), "mic path should not include anullsrc: {args}");
    }

    #[test]
    fn audio_input_args_ordered_correctly() {
        // Verify -i pipe:0 (video) comes BEFORE the fifo -i. If they
        // swap, FFmpeg attaches the -f/-ar/-ac flags to the wrong stream
        // and everything breaks.
        let mut c = cfg();
        c.audio_input = Some(AudioInput {
            fifo_path: PathBuf::from("/tmp/x.fifo"),
            sample_rate: 48_000,
            channels: 2,
            format: AudioFormat::F32LE,
        });
        let args = c.to_ffmpeg_args();
        let video_idx = args
            .iter()
            .position(|a| a == "pipe:0")
            .expect("pipe:0 must be present");
        let fifo_idx = args
            .iter()
            .position(|a| a == "/tmp/x.fifo")
            .expect("fifo path must be present");
        assert!(
            video_idx < fifo_idx,
            "video -i pipe:0 must precede audio -i fifo; got video at {video_idx} vs fifo at {fifo_idx}"
        );
    }

    #[test]
    fn with_audio_builder_sets_field() {
        let c = cfg().with_audio(AudioInput {
            fifo_path: PathBuf::from("/tmp/a"),
            sample_rate: 44_100,
            channels: 2,
            format: AudioFormat::S16LE,
        });
        assert!(c.audio_input.is_some());
        let args = c.to_ffmpeg_args().join(" ");
        assert!(args.contains("-f s16le"), "s16le variant missing: {args}");
        assert!(args.contains("-ar 44100"));
    }
}

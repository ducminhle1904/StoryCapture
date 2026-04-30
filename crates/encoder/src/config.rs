//! `EncodeConfig` values for one recording.
//!
//! Capture dims drive the rawvideo stdin (`-s`); output dims drive the
//! `scale+pad` filter target. `to_ffmpeg_args` delegates filter-graph
//! synthesis to `crate::filters::build_vf` and rate-control flag synthesis
//! to `crate::quality::resolve` — nothing in this file hand-rolls FFmpeg
//! argv fragments for either.

use std::path::PathBuf;

use crate::error::{EncoderError, Result};
use crate::filters::{
    self, FilterSpec, FitMode, OutputResolution, PadColor, QualityPreset, ScaleAlgo,
};
use crate::probe::HardwareEncoder;
use crate::quality;

/// Raw PCM format for the mic audio FIFO.
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

/// Mic audio input for the encoder.
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
    /// Source frame dimensions for rawvideo stdin `-s WxH`. Always native capture dims.
    pub capture_width: u32,
    pub capture_height: u32,
    /// Target output frame dimensions after scale+pad. Must be even.
    pub output_width: u32,
    pub output_height: u32,
    pub fit_mode: FitMode,
    pub pad_color: PadColor,
    pub scale_algo: ScaleAlgo,
    pub quality_preset: QualityPreset,
    /// Fixed output cadence for the FFmpeg stdin path. The macOS VT fast
    /// path preserves native capture PTS; raw BGRA over stdin does not.
    pub fps_advisory: u32,
    pub encoder: HardwareEncoder,
    /// Manual target bitrate override in kbps. 0 = preset-driven.
    pub bitrate_kbps: u32,
    /// Optional mic input.
    pub audio_input: Option<AudioInput>,
    /// Force the rawvideo -> FFmpeg path even when a platform-native fast
    /// path is available. Recorder sessions use this so pause/resume shortens
    /// the timeline instead of preserving native timestamp gaps.
    pub force_ffmpeg_path: bool,
    /// Optional keyframe interval in seconds. `Some(n)` emits `-g (fps * n)`;
    /// `None` omits the flag and keeps FFmpeg's default GOP.
    pub keyframe_interval_sec: Option<u32>,
    /// Per-frame stdin write timeout. `None` waits indefinitely; `Some(ms)`
    /// drops the frame and bumps the backpressure counter on elapse.
    /// Default `Some(200)` preserves the previously hardcoded behavior.
    pub stdin_write_timeout_ms: Option<u64>,
    /// Wait budget for the first FFmpeg frame to land on stdin.
    /// Default `Some(30_000)` mirrors a generous startup window.
    pub first_frame_timeout_ms: Option<u64>,
    /// Expected (W, H) from the capture stage. When `Some`, the pipeline
    /// emits a structured warning and bumps `mismatch_dropped` if a frame
    /// arrives at a different size. Pure metadata — drop logic is unchanged.
    pub capture_dims: Option<(u32, u32)>,
}

impl EncodeConfig {
    pub fn new(
        output_path: PathBuf,
        capture_width: u32,
        capture_height: u32,
        fps_advisory: u32,
        encoder: HardwareEncoder,
    ) -> Self {
        let out_w = capture_width & !1;
        let out_h = capture_height & !1;
        EncodeConfig {
            output_path,
            capture_width,
            capture_height,
            output_width: out_w,
            output_height: out_h,
            fit_mode: FitMode::Letterbox,
            pad_color: PadColor::Black,
            scale_algo: ScaleAlgo::Lanczos,
            quality_preset: QualityPreset::Med,
            fps_advisory,
            encoder,
            bitrate_kbps: 0,
            audio_input: None,
            force_ffmpeg_path: false,
            keyframe_interval_sec: None,
            stdin_write_timeout_ms: Some(200),
            first_frame_timeout_ms: Some(30_000),
            capture_dims: None,
        }
    }

    pub fn with_output_resolution(mut self, preset: OutputResolution) -> Result<Self> {
        let (w, h) = preset.resolve_even(self.capture_width, self.capture_height)?;
        self.output_width = w;
        self.output_height = h;
        Ok(self)
    }

    pub fn with_fit_mode(mut self, fit: FitMode) -> Self {
        self.fit_mode = fit;
        self
    }

    pub fn with_pad_color(mut self, color: PadColor) -> Self {
        self.pad_color = color;
        self
    }

    pub fn with_scale_algo(mut self, algo: ScaleAlgo) -> Self {
        self.scale_algo = algo;
        self
    }

    pub fn with_quality_preset(mut self, preset: QualityPreset) -> Self {
        self.quality_preset = preset;
        self
    }

    /// Sets `bitrate_kbps` to the pixel-based target for the current output dims and fps.
    pub fn with_auto_bitrate(mut self) -> Self {
        self.bitrate_kbps =
            quality::pixel_based_kbps(self.output_width, self.output_height, self.fps_advisory);
        self
    }

    /// Attach mic input.
    pub fn with_audio(mut self, audio: AudioInput) -> Self {
        self.audio_input = Some(audio);
        self
    }

    pub fn force_ffmpeg_path(mut self) -> Self {
        self.force_ffmpeg_path = true;
        self
    }

    pub fn validate(&self) -> Result<()> {
        if self.capture_width == 0 || self.capture_height == 0 {
            return Err(EncoderError::InvalidConfig(format!(
                "zero capture dimension: {}x{}",
                self.capture_width, self.capture_height
            )));
        }
        if self.output_width == 0 || self.output_height == 0 {
            return Err(EncoderError::InvalidConfig(format!(
                "zero output dimension: {}x{}",
                self.output_width, self.output_height
            )));
        }
        if self.output_width % 2 != 0 || self.output_height % 2 != 0 {
            return Err(EncoderError::InvalidConfig(format!(
                "output dims must be even: {}x{}",
                self.output_width, self.output_height
            )));
        }
        if self.fps_advisory == 0 {
            return Err(EncoderError::InvalidConfig(
                "fps_advisory must be > 0".into(),
            ));
        }
        if self.output_path.as_os_str().is_empty() {
            return Err(EncoderError::InvalidConfig("empty output_path".into()));
        }
        Ok(())
    }

    /// Render the FFmpeg argv without the binary path.
    pub fn to_ffmpeg_args(&self) -> Vec<String> {
        let spec = FilterSpec {
            capture_w: self.capture_width,
            capture_h: self.capture_height,
            output_w: self.output_width,
            output_h: self.output_height,
            fit: self.fit_mode,
            pad_color: self.pad_color,
            scale_algo: self.scale_algo,
        };
        let vf =
            filters::build_vf(&spec).expect("EncodeConfig was not validated before to_ffmpeg_args");

        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-y".into(),
            "-thread_queue_size".into(),
            "1024".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "bgra".into(),
            "-s".into(),
            format!("{}x{}", self.capture_width, self.capture_height),
            "-r".into(),
            self.fps_advisory.to_string(),
            "-i".into(),
            "pipe:0".into(),
        ];

        match &self.audio_input {
            Some(audio) => {
                args.extend([
                    "-thread_queue_size".into(),
                    "1024".into(),
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

        if self.audio_input.is_some() {
            args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "1:a:0".into()]);
        }

        let codec = self.encoder.ffmpeg_codec_name();
        args.extend([
            "-vf".into(),
            vf,
            "-c:v".into(),
            codec.into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
        // HEVC in MP4: FFmpeg defaults to `hev1` fourcc (parameter sets in
        // SPS/PPS NALUs), which QuickTime / Safari / Finder preview refuse
        // to open. Force `hvc1` (inline parameter sets) so macOS players
        // accept the file.
        if matches!(self.encoder, HardwareEncoder::VideoToolboxHevc) {
            args.extend(["-tag:v".into(), "hvc1".into()]);
        }
        args.extend([
            // Explicit BT.709 tagging so every player (QuickTime, Safari,
            // Chrome, VLC) interprets the same color range — otherwise the
            // MP4 can look washed-out or over-saturated depending on the
            // player's guess.
            "-color_range".into(),
            "tv".into(),
            "-colorspace".into(),
            "bt709".into(),
            "-color_primaries".into(),
            "bt709".into(),
            "-color_trc".into(),
            "bt709".into(),
        ]);
        if matches!(self.encoder, HardwareEncoder::Libx264Software) {
            args.extend([
                "-x264-params".into(),
                "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv".into(),
            ]);
        }
        args.extend(quality::resolve(
            self.quality_preset,
            self.encoder,
            self.output_width,
            self.output_height,
            self.fps_advisory,
        ));

        // Keyframe interval (forces GOP). None => default FFmpeg behavior
        // — argv must be byte-identical to the no-flag case.
        if let Some(sec) = self.keyframe_interval_sec {
            let gop = (self.fps_advisory).saturating_mul(sec).max(1);
            args.extend(["-g".into(), gop.to_string()]);
        }

        args.extend(["-c:a".into(), "aac".into()]);

        if self.audio_input.is_some() {
            args.extend(["-b:a".into(), "128k".into(), "-ac".into(), "2".into()]);
        } else {
            args.extend(["-b:a".into(), "64k".into()]);
        }

        args.extend([
            "-fps_mode".into(),
            "cfr".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-shortest".into(),
            "-progress".into(),
            "pipe:2".into(),
            "-loglevel".into(),
            "info".into(),
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
            HardwareEncoder::Libx264Software,
        )
    }

    #[test]
    fn ffmpeg_args_contain_required_flags() {
        let args = cfg().to_ffmpeg_args().join(" ");
        assert!(
            args.contains("-progress pipe:2"),
            "progress flag missing: {args}"
        );
        assert!(
            args.contains("-fps_mode cfr"),
            "fps_mode cfr missing: {args}"
        );
        assert!(
            args.contains("-movflags +faststart"),
            "faststart missing: {args}"
        );
        assert!(
            args.contains("-pix_fmt bgra"),
            "pix_fmt bgra missing: {args}"
        );
        assert!(args.contains("-f rawvideo"), "rawvideo missing: {args}");
        assert!(args.contains("pipe:0"), "stdin input missing: {args}");
        assert!(args.contains("anullsrc"), "silent audio missing: {args}");
        assert!(args.contains("libx264"), "encoder name missing: {args}");
        assert!(args.contains("-s 1280x720"), "capture dims missing: {args}");
    }

    #[test]
    fn validate_rejects_zero_dims() {
        let mut c = cfg();
        c.capture_width = 0;
        assert!(c.validate().is_err());
    }

    #[test]
    fn test_validate_rejects_odd_output_dims() {
        let mut c = cfg();
        c.output_width = 1919;
        assert!(c.validate().is_err());
    }

    #[test]
    fn audio_none_path_preserves_phase1_args() {
        let args = cfg().to_ffmpeg_args().join(" ");
        assert!(args.contains("-f lavfi -i anullsrc=r=48000:cl=mono"));
        assert!(args.contains("-b:a 64k"));
        assert!(
            !args.contains("-map"),
            "silent-audio path must not add explicit stream mapping: {args}"
        );
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
        assert!(args.contains("-f f32le"), "missing -f f32le: {args}");
        assert!(args.contains("-ar 48000"), "missing -ar 48000: {args}");
        assert!(args.contains("-ac 1"), "missing -ac 1 for mono mic: {args}");
        assert!(args.contains("-i /tmp/mic.fifo"), "missing fifo -i: {args}");
        assert!(
            args.contains("-map 0:v:0 -map 1:a:0"),
            "missing maps: {args}"
        );
        assert!(args.contains("-b:a 128k"), "missing 128k audio: {args}");
        assert!(args.contains("-ac 2"), "missing stereo downmix: {args}");
        assert!(
            !args.contains("anullsrc"),
            "mic path should not include anullsrc: {args}"
        );
    }

    #[test]
    fn audio_input_args_ordered_correctly() {
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

    /// Bitrate is target, not floor. Formula uses 5 bits/pixel, so 4K at
    /// 30fps lands at the pixel-derived budget below the 80 Mbps cap.
    #[test]
    fn test_4k_uses_target_bitrate() {
        let cfg = EncodeConfig::new(
            PathBuf::from("/tmp/4k.mp4"),
            3840,
            2160,
            30,
            HardwareEncoder::Libx264Software,
        )
        .with_output_resolution(OutputResolution::P2160)
        .unwrap()
        .with_auto_bitrate();
        assert_eq!(
            cfg.bitrate_kbps, 41_472,
            "auto_bitrate should use the 3840x2160@30 pixel budget"
        );
        let args = cfg.to_ffmpeg_args();
        assert!(
            !args.iter().any(|a| a == "-b:v"),
            "libx264 Med must use CRF, not -b:v"
        );
        assert!(
            args.windows(2).any(|w| w[0] == "-crf" && w[1] == "20"),
            "Med preset → -crf 20 (screen content tune)"
        );
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-tune" && w[1] == "stillimage"));
    }

    #[test]
    fn test_letterbox_vf_wired() {
        let cfg = EncodeConfig::new(
            PathBuf::from("/tmp/lb.mp4"),
            1920,
            1130,
            30,
            HardwareEncoder::Libx264Software,
        )
        .with_output_resolution(OutputResolution::P1080)
        .unwrap();
        let args = cfg.to_ffmpeg_args();
        let vf_idx = args
            .iter()
            .position(|a| a == "-vf")
            .expect("-vf must be present");
        let vf = &args[vf_idx + 1];
        assert!(
            vf.contains("force_original_aspect_ratio=decrease"),
            "letterbox scale flag missing: {vf}"
        );
        assert!(vf.contains("pad=1920:1080"), "pad target missing: {vf}");
        assert!(vf.contains("setsar=1"), "setsar missing: {vf}");
    }

    #[test]
    fn test_output_dims_differ_from_capture_in_minus_s() {
        let cfg = EncodeConfig::new(
            PathBuf::from("/tmp/s.mp4"),
            1920,
            1130,
            30,
            HardwareEncoder::Libx264Software,
        )
        .with_output_resolution(OutputResolution::P1080)
        .unwrap();
        let args = cfg.to_ffmpeg_args();
        let s_idx = args.iter().position(|a| a == "-s").expect("-s present");
        assert_eq!(
            &args[s_idx + 1],
            "1920x1130",
            "-s must carry capture dims, not output dims"
        );
    }

    /// keyframe_interval_sec = Some(2) @ 30fps -> `-g 60`.
    #[test]
    fn keyframe_interval_emits_g_flag() {
        let mut c = cfg();
        c.keyframe_interval_sec = Some(2);
        let args = c.to_ffmpeg_args();
        let g_idx = args
            .iter()
            .position(|a| a == "-g")
            .expect("-g must be present");
        assert_eq!(args[g_idx + 1], "60", "expected -g 60 for 30fps * 2s");
    }

    /// None keeps argv byte-identical to the no-flag case.
    #[test]
    fn keyframe_interval_none_omits_g_flag() {
        let c = cfg();
        assert!(c.keyframe_interval_sec.is_none());
        let args = c.to_ffmpeg_args();
        assert!(
            !args.iter().any(|a| a == "-g"),
            "default config must not emit -g: {args:?}"
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

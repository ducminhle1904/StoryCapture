//! `EncodeConfig` values for one recording.
//!
//! Resolution and framerate come from capture. Audio defaults to a silent AAC track.

use std::path::PathBuf;

use crate::error::{EncoderError, Result};
use crate::probe::HardwareEncoder;

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
    pub width: u32,
    pub height: u32,
    /// Fixed output cadence for the FFmpeg stdin path. The macOS VT fast
    /// path preserves native capture PTS; raw BGRA over stdin does not.
    pub fps_advisory: u32,
    pub encoder: HardwareEncoder,
    /// Video bitrate in kbps.
    pub bitrate_kbps: u32,
    /// Optional mic input.
    pub audio_input: Option<AudioInput>,
    /// Force the rawvideo -> FFmpeg path even when a platform-native fast
    /// path is available. Recorder sessions use this so pause/resume shortens
    /// the timeline instead of preserving native timestamp gaps.
    pub force_ffmpeg_path: bool,
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
            force_ffmpeg_path: false,
        }
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
        if self.width == 0 || self.height == 0 {
            return Err(EncoderError::InvalidConfig(format!(
                "zero dimension: {}x{}",
                self.width, self.height
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
        // Bitrate scales with pixel count.
        let pixel_based_kbps = ((self.width as u64 * self.height as u64 * 3) / 1000) as u32;
        let target_kbps = pixel_based_kbps.max(self.bitrate_kbps).min(40_000);
        let bitrate = format!("{}k", target_kbps);
        let scale_filter = "scale='min(1920,iw)':-2,scale=trunc(iw/2)*2:trunc(ih/2)*2".to_string();

        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-y".into(),
            "-thread_queue_size".into(),
            "1024".into(),
            // Raw BGRA input on stdin at a fixed cadence.
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "bgra".into(),
            "-s".into(),
            format!("{}x{}", self.width, self.height),
            "-r".into(),
            self.fps_advisory.to_string(),
            "-i".into(),
            "pipe:0".into(),
        ];

        // Audio input. Silence is the fallback.
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

        // Explicit mapping only when real audio is present.
        if self.audio_input.is_some() {
            args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "1:a:0".into()]);
        }

        args.extend([
            // Downscale + even-dim video filter.
            "-vf".into(),
            scale_filter,
            // Video encode.
            "-c:v".into(),
            self.encoder.ffmpeg_codec_name().into(),
            "-b:v".into(),
            bitrate,
            "-pix_fmt".into(),
            "yuv420p".into(),
            // Audio encode.
            "-c:a".into(),
            "aac".into(),
        ]);

        // Mic input gets a higher bitrate than the silent fallback.
        if self.audio_input.is_some() {
            args.extend(["-b:a".into(), "128k".into(), "-ac".into(), "2".into()]);
        } else {
            args.extend(["-b:a".into(), "64k".into()]);
        }

        args.extend([
            // Framing and packaging.
            "-fps_mode".into(),
            "cfr".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-shortest".into(),
            // Progress and logs.
            "-progress".into(),
            "pipe:2".into(),
            "-loglevel".into(),
            "info".into(),
            // Output.
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
        assert!(args.contains("libopenh264"), "encoder name missing: {args}");
        assert!(args.contains("1280x720"), "resolution missing: {args}");
    }

    #[test]
    fn validate_rejects_zero_dims() {
        let mut c = cfg();
        c.width = 0;
        assert!(c.validate().is_err());
    }

    // Audio dual-input arg shape.

    /// Regression guard for the silent-audio path.
    #[test]
    fn audio_none_path_preserves_phase1_args() {
        let args = cfg().to_ffmpeg_args().join(" ");
        assert!(args.contains("-f lavfi -i anullsrc=r=48000:cl=mono"));
        assert!(args.contains("-b:a 64k"));
        // No explicit -map in the silent path.
        assert!(
            !args.contains("-map"),
            "silent-audio path must not add explicit stream mapping: {args}"
        );
        // 128k is the mic-path default.
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
        // Raw PCM input follows the video input.
        assert!(args.contains("-f f32le"), "missing -f f32le: {args}");
        assert!(args.contains("-ar 48000"), "missing -ar 48000: {args}");
        assert!(args.contains("-ac 1"), "missing -ac 1 for mono mic: {args}");
        assert!(args.contains("-i /tmp/mic.fifo"), "missing fifo -i: {args}");
        // Explicit mapping so FFmpeg uses the FIFO audio.
        assert!(
            args.contains("-map 0:v:0 -map 1:a:0"),
            "missing maps: {args}"
        );
        // AAC 128 kbps stereo output.
        assert!(args.contains("-b:a 128k"), "missing 128k audio: {args}");
        assert!(args.contains("-ac 2"), "missing stereo downmix: {args}");
        // `anullsrc` is absent on the mic path.
        assert!(
            !args.contains("anullsrc"),
            "mic path should not include anullsrc: {args}"
        );
    }

    #[test]
    fn audio_input_args_ordered_correctly() {
        // Verify the video input comes before the FIFO input.
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

    /// Regression guard for the 4K bitrate floor.
    #[test]
    fn test_4k_exceeds_floor() {
        let c = EncodeConfig::new(
            PathBuf::from("/tmp/4k.mp4"),
            3840,
            2160,
            30,
            HardwareEncoder::Openh264Software,
        );
        let args = c.to_ffmpeg_args();
        let bv_idx = args
            .iter()
            .position(|a| a == "-b:v")
            .expect("-b:v must be present");
        let bitrate = &args[bv_idx + 1];
        // Parse "NNNNNk" to `u32`.
        let kbps: u32 = bitrate
            .trim_end_matches('k')
            .parse()
            .expect("bitrate is numeric kbps");
        assert!(
            kbps > 12_000,
            "4K bitrate must exceed the 12 Mbps default floor; got {kbps}k"
        );
        assert!(
            kbps <= 40_000,
            "4K bitrate must stay within the 40 Mbps cap; got {kbps}k"
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

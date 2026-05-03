//! Fan-out: FFV1 intermediate → N parallel encoders.
//!
//! Smart batch reuse: given one intermediate and a [`FanoutPlan`] listing
//! the desired outputs, spawn one FFmpeg sidecar per output in parallel
//! and return the produced file paths once they all complete.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::try_join_all;

use crate::error::{EncoderError, Result};
use crate::fanout::intermediate::IntermediateOutput;
use crate::filters::QualityPreset;
use crate::filters::ScaleAlgo;
use crate::probe::HardwareEncoder;
use crate::quality;
use crate::sidecar::SidecarCommand;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportRateControl {
    Auto,
    Cbr,
    Vbr,
    Crf,
    Cq,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportX264Preset {
    Ultrafast,
    Superfast,
    Veryfast,
    Faster,
    Fast,
    Medium,
    Slow,
    Slower,
    Veryslow,
}

impl ExportX264Preset {
    fn ffmpeg_value(self) -> &'static str {
        match self {
            ExportX264Preset::Ultrafast => "ultrafast",
            ExportX264Preset::Superfast => "superfast",
            ExportX264Preset::Veryfast => "veryfast",
            ExportX264Preset::Faster => "faster",
            ExportX264Preset::Fast => "fast",
            ExportX264Preset::Medium => "medium",
            ExportX264Preset::Slow => "slow",
            ExportX264Preset::Slower => "slower",
            ExportX264Preset::Veryslow => "veryslow",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportAudioCodec {
    Aac,
    Opus,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExportAudioOptions {
    pub codec: ExportAudioCodec,
    pub bitrate_kbps: u32,
    pub channels: u8,
    pub sample_rate_hz: u32,
}

impl Default for ExportAudioOptions {
    fn default() -> Self {
        Self {
            codec: ExportAudioCodec::Aac,
            bitrate_kbps: 160,
            channels: 2,
            sample_rate_hz: 48_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExportEncodeOptions {
    pub encoder: Option<HardwareEncoder>,
    pub rate_control: ExportRateControl,
    pub quality_value: Option<u32>,
    pub x264_preset: Option<ExportX264Preset>,
    pub keyframe_interval_sec: Option<u32>,
    pub downscale_algo: ScaleAlgo,
    pub audio: ExportAudioOptions,
}

impl Default for ExportEncodeOptions {
    fn default() -> Self {
        Self {
            encoder: None,
            rate_control: ExportRateControl::Auto,
            quality_value: None,
            x264_preset: None,
            keyframe_interval_sec: Some(2),
            downscale_algo: ScaleAlgo::Lanczos,
            audio: ExportAudioOptions::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Mp4,
    WebM,
    Gif,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    MatchSource,
    R720p,
    R1080p,
    R4k,
    Custom { width: u32, height: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Low,
    Med,
    High,
}

#[derive(Debug, Clone)]
pub struct OutputSpec {
    pub format: OutputFormat,
    pub resolution: Resolution,
    pub fps: u32,
    pub quality: Quality,
    pub encoder_options: Option<ExportEncodeOptions>,
    pub output_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct FanoutPlan {
    pub outputs: Vec<OutputSpec>,
}

impl FanoutPlan {
    /// Build a fanout plan for a batch. Output paths are synthesised by
    /// concatenating `out_dir`, `stem`, and the per-format extension.
    pub fn batch(
        formats: Vec<OutputFormat>,
        resolution: Resolution,
        fps: u32,
        quality: Quality,
        out_dir: &Path,
        stem: &str,
    ) -> Self {
        let outputs = formats
            .into_iter()
            .map(|format| OutputSpec {
                format,
                resolution,
                fps,
                quality,
                encoder_options: None,
                output_path: out_dir.join(format!("{stem}{}", ext_for(format))),
            })
            .collect();
        Self { outputs }
    }
}

fn ext_for(f: OutputFormat) -> &'static str {
    match f {
        OutputFormat::Mp4 => ".mp4",
        OutputFormat::WebM => ".webm",
        OutputFormat::Gif => ".gif",
    }
}

pub fn resolution_width(r: Resolution) -> u32 {
    match r {
        Resolution::MatchSource => 1920,
        Resolution::R720p => 1280,
        Resolution::R1080p => 1920,
        Resolution::R4k => 3840,
        Resolution::Custom { width, .. } => width,
    }
}

pub fn resolution_height(r: Resolution) -> u32 {
    match r {
        Resolution::MatchSource => 1080,
        Resolution::R720p => 720,
        Resolution::R1080p => 1080,
        Resolution::R4k => 2160,
        Resolution::Custom { height, .. } => height,
    }
}

/// Approximate bitrate selection. Tuned for "good-enough" defaults; the
/// renderer tier picker may override these per-preset.
pub fn bitrate_for(r: Resolution, q: Quality, codec: &str) -> String {
    let base: u32 = match (r, codec) {
        (Resolution::R720p, "h264") => 4_000,
        (Resolution::R1080p, "h264") => 8_000,
        (Resolution::R4k, "h264") => 24_000,
        (Resolution::R720p, "vp9") => 2_500,
        (Resolution::R1080p, "vp9") => 5_000,
        (Resolution::R4k, "vp9") => 15_000,
        _ => 8_000,
    };
    let mult = match q {
        Quality::Low => 0.6,
        Quality::Med => 1.0,
        Quality::High => 1.5,
    };
    format!("{}k", (base as f32 * mult) as u32)
}

/// Best H.264 encoder — defaults to bundled libx264.
pub fn default_h264_encoder() -> HardwareEncoder {
    HardwareEncoder::Libx264Software
}

/// Build the argv for a single MP4/WebM/GIF encode pass. Pure + unit-
/// testable; [`fanout_encode`] calls it per output.
pub fn build_encode_args(
    intermediate: &Path,
    spec: &OutputSpec,
    h264_encoder: HardwareEncoder,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-i".into(),
        intermediate.to_string_lossy().into_owned(),
    ];
    let w = resolution_width(spec.resolution);
    let h = resolution_height(spec.resolution);
    match spec.format {
        OutputFormat::Mp4 => {
            args.push("-vf".into());
            args.push(format!(
                "scale={w}:{h}:flags={}",
                scale_algo(spec).ffmpeg_flag()
            ));
            push_mp4_video_encode_args(&mut args, spec, h264_encoder, w, h);
            push_audio_args(&mut args, spec);
            args.push("-movflags".into());
            args.push("+faststart".into());
            args.push("-fps_mode".into());
            args.push("cfr".into());
            args.push("-r".into());
            args.push(spec.fps.to_string());
        }
        OutputFormat::WebM => {
            args.push("-vf".into());
            args.push(format!(
                "scale={w}:{h}:flags={}",
                scale_algo(spec).ffmpeg_flag()
            ));
            args.push("-c:v".into());
            args.push("libvpx-vp9".into());
            args.push("-b:v".into());
            args.push(bitrate_for(spec.resolution, spec.quality, "vp9"));
            args.push("-c:a".into());
            args.push("libopus".into());
            args.push("-b:a".into());
            args.push("128k".into());
            args.push("-r".into());
            args.push(spec.fps.to_string());
        }
        OutputFormat::Gif => {
            // 2-pass palette — Pitfall #7. `palettegen=stats_mode=full`
            // scans the entire clip; `paletteuse=dither=bayer` is the
            // most size-friendly dither at the cost of some banding.
            args.push("-filter_complex".into());
            args.push(format!(
                "[0:v]fps={fps},scale={w}:-1:flags=lanczos,split[a][b];\
                 [a]palettegen=stats_mode=full[p];\
                 [b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
                fps = spec.fps,
                w = w
            ));
        }
    }
    args.push(spec.output_path.to_string_lossy().into_owned());
    args
}

pub(crate) fn export_quality_to_preset(quality: Quality) -> QualityPreset {
    match quality {
        Quality::Low => QualityPreset::Low,
        Quality::Med => QualityPreset::Med,
        Quality::High => QualityPreset::High,
    }
}

pub(crate) fn push_mp4_video_encode_args(
    args: &mut Vec<String>,
    spec: &OutputSpec,
    encoder: HardwareEncoder,
    width: u32,
    height: u32,
) {
    args.push("-c:v".into());
    args.push(encoder.ffmpeg_codec_name().into());
    if let Some(options) = spec.encoder_options.as_ref() {
        args.extend(resolve_export_quality_args(
            options, spec, encoder, width, height,
        ));
    } else {
        args.extend(quality::resolve(
            export_quality_to_preset(spec.quality),
            encoder,
            width,
            height,
            spec.fps,
        ));
    }
    if let Some(seconds) = spec
        .encoder_options
        .as_ref()
        .and_then(|options| options.keyframe_interval_sec)
    {
        args.push("-g".into());
        args.push((spec.fps.saturating_mul(seconds)).to_string());
    }
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.extend(quality::mp4_color_args(encoder));
}

pub(crate) fn scale_algo(spec: &OutputSpec) -> ScaleAlgo {
    spec.encoder_options
        .as_ref()
        .map(|options| options.downscale_algo)
        .unwrap_or(ScaleAlgo::Lanczos)
}

pub(crate) fn push_audio_args(args: &mut Vec<String>, spec: &OutputSpec) {
    let audio = spec
        .encoder_options
        .as_ref()
        .map(|options| options.audio.clone())
        .unwrap_or_default();
    args.push("-c:a".into());
    args.push(
        match audio.codec {
            ExportAudioCodec::Aac => "aac",
            ExportAudioCodec::Opus => "libopus",
        }
        .into(),
    );
    args.push("-b:a".into());
    args.push(format!("{}k", audio.bitrate_kbps));
    args.push("-ac".into());
    args.push(audio.channels.to_string());
    args.push("-ar".into());
    args.push(audio.sample_rate_hz.to_string());
}

fn resolve_export_quality_args(
    options: &ExportEncodeOptions,
    spec: &OutputSpec,
    encoder: HardwareEncoder,
    width: u32,
    height: u32,
) -> Vec<String> {
    if options.rate_control == ExportRateControl::Auto && options.quality_value.is_none() {
        return quality::resolve(
            export_quality_to_preset(spec.quality),
            encoder,
            width,
            height,
            spec.fps,
        );
    }
    let value = options.quality_value.unwrap_or(match encoder {
        HardwareEncoder::Libx264Software => 18,
        HardwareEncoder::NvencH264
        | HardwareEncoder::QsvH264
        | HardwareEncoder::AmfH264
        | HardwareEncoder::Openh264Software => 20,
        HardwareEncoder::VideoToolboxH264 | HardwareEncoder::VideoToolboxHevc => {
            quality::target_kbps(
                export_quality_to_preset(spec.quality),
                encoder,
                width,
                height,
                spec.fps,
            ) / 1000
        }
    });
    match encoder {
        HardwareEncoder::Libx264Software => {
            let preset = options
                .x264_preset
                .unwrap_or(ExportX264Preset::Slow)
                .ffmpeg_value();
            vec![
                "-crf".into(),
                value.to_string(),
                "-preset".into(),
                preset.into(),
                "-tune".into(),
                "stillimage".into(),
                "-profile:v".into(),
                "high".into(),
            ]
        }
        HardwareEncoder::VideoToolboxH264 | HardwareEncoder::VideoToolboxHevc => vec![
            "-b:v".into(),
            format!("{value}M"),
            "-constant_bit_rate".into(),
            matches!(options.rate_control, ExportRateControl::Cbr).to_string(),
            "-realtime".into(),
            "false".into(),
            "-prio_speed".into(),
            "false".into(),
            "-power_efficient".into(),
            "0".into(),
        ],
        HardwareEncoder::NvencH264 => vec![
            "-preset".into(),
            "p4".into(),
            "-rc".into(),
            if matches!(options.rate_control, ExportRateControl::Cbr) {
                "cbr"
            } else {
                "vbr"
            }
            .into(),
            "-cq".into(),
            value.to_string(),
        ],
        HardwareEncoder::QsvH264 => vec![
            "-preset".into(),
            "medium".into(),
            "-global_quality".into(),
            value.to_string(),
        ],
        HardwareEncoder::AmfH264 => vec![
            "-quality".into(),
            "quality".into(),
            "-rc".into(),
            "cqp".into(),
            "-qp_i".into(),
            value.to_string(),
            "-qp_p".into(),
            value.saturating_add(2).to_string(),
        ],
        HardwareEncoder::Openh264Software => vec![
            "-b:v".into(),
            format!("{value}M"),
            "-profile:v".into(),
            "high".into(),
            "-rc_mode".into(),
            "bitrate".into(),
        ],
    }
}

/// Fan out to N parallel encoders. Each `SidecarCommand` is invoked with
/// the per-output argv; [`try_join_all`] awaits all of them.
///
/// `sidecar_factory` is called once per output to produce an independent
/// `Arc<dyn SidecarCommand>` (the same command object may be shared —
/// it's `Send + Sync` — but a factory lets tests return scripted doubles
/// with per-call state).
pub async fn fanout_encode(
    intermediate: &IntermediateOutput,
    plan: &FanoutPlan,
    sidecar_factory: impl Fn() -> Arc<dyn SidecarCommand>,
    h264_encoder: HardwareEncoder,
) -> Result<Vec<PathBuf>> {
    let tasks: Vec<_> = plan
        .outputs
        .iter()
        .map(|spec| {
            let cmd = sidecar_factory();
            let input = intermediate.path.clone();
            let spec = spec.clone();
            tokio::spawn(async move {
                let args = build_encode_args(&input, &spec, h264_encoder);
                // `run` spawns the sidecar AND awaits its exit status. The
                // returned path therefore always refers to a completed
                // encode: callers downstream (RenderQueueActor,
                // reconcile_done, UI progress) can rely on the file being
                // fully flushed to disk.
                cmd.run(args).await?;
                Result::<PathBuf>::Ok(spec.output_path)
            })
        })
        .collect();
    let joined = try_join_all(tasks)
        .await
        .map_err(|e| EncoderError::Io(format!("fanout join: {e}")))?;
    joined.into_iter().collect::<Result<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    fn spec(fmt: OutputFormat, path: &str) -> OutputSpec {
        OutputSpec {
            format: fmt,
            resolution: Resolution::R1080p,
            fps: 60,
            quality: Quality::Med,
            encoder_options: None,
            output_path: PathBuf::from(path),
        }
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
        assert!(plan.outputs[0]
            .output_path
            .to_string_lossy()
            .ends_with("clip.mp4"));
        assert!(plan.outputs[1]
            .output_path
            .to_string_lossy()
            .ends_with("clip.webm"));

        let mp4 = build_encode_args(
            Path::new("/tmp/interm.mkv"),
            &plan.outputs[0],
            HardwareEncoder::VideoToolboxH264,
        );
        assert!(mp4.iter().any(|a| a == "h264_videotoolbox"));
        let webm = build_encode_args(
            Path::new("/tmp/interm.mkv"),
            &plan.outputs[1],
            HardwareEncoder::Libx264Software,
        );
        assert!(webm.iter().any(|a| a == "libvpx-vp9"));
    }

    #[test]
    fn gif_2pass_palette() {
        let s = spec(OutputFormat::Gif, "/tmp/out.gif");
        let args = build_encode_args(
            Path::new("/tmp/interm.mkv"),
            &s,
            HardwareEncoder::Libx264Software,
        );
        let joined = args.join(" ");
        assert!(joined.contains("palettegen"));
        assert!(joined.contains("paletteuse"));
    }

    // ---- Async parallel-spawn test --------------------------------------

    /// Scripted sidecar that records every `spawn` argv into a shared
    /// vec and returns a bogus child (piped stdio on `true`/`cmd /c`).
    struct RecordingCmd {
        calls: Arc<Mutex<Vec<Vec<String>>>>,
    }

    #[async_trait]
    impl SidecarCommand for RecordingCmd {
        async fn spawn(&self, args: Vec<String>) -> Result<crate::sidecar::SidecarChild> {
            self.calls.lock().unwrap().push(args);
            // Spawn a trivial `true`/`rundll32` that exits immediately so
            // we can return a real SidecarChild. On macOS+Linux `true`
            // exits 0; on Windows we use `cmd /c exit 0`.
            #[cfg(unix)]
            let mut cmd = tokio::process::Command::new("true");
            #[cfg(windows)]
            let mut cmd = {
                let mut c = tokio::process::Command::new("cmd");
                c.arg("/c").arg("exit 0");
                c
            };
            use std::process::Stdio;
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = cmd
                .spawn()
                .map_err(|e| EncoderError::SpawnFailed(e.to_string()))?;
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            Ok(crate::sidecar::SidecarChild {
                stdin,
                stdout,
                stderr,
                child,
            })
        }
    }

    #[tokio::test]
    async fn multi_encode_parallel_spawns() {
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
        let outputs = fanout_encode(
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
        assert_eq!(outputs.len(), 2);
        let recorded = calls.lock().unwrap();
        assert_eq!(recorded.len(), 2, "two sidecars must be spawned");
        // Confirm each call is distinct.
        let joined_0 = recorded[0].join(" ");
        let joined_1 = recorded[1].join(" ");
        let (mp4_args, webm_args) = if joined_0.contains("libvpx-vp9") {
            (&joined_1, &joined_0)
        } else {
            (&joined_0, &joined_1)
        };
        assert!(mp4_args.contains("libx264"));
        assert!(webm_args.contains("libvpx-vp9"));
    }

    /// Sidecar double whose `run` actually writes the output file before
    /// returning — proves that `fanout_encode` only resolves AFTER each
    /// per-output task has finished, so the returned path is guaranteed
    /// to exist on disk.
    struct WritingCmd;

    #[async_trait]
    impl SidecarCommand for WritingCmd {
        async fn spawn(&self, _args: Vec<String>) -> Result<crate::sidecar::SidecarChild> {
            unreachable!("fanout_encode uses run(), not spawn()");
        }

        async fn run(&self, args: Vec<String>) -> Result<()> {
            // Output path is the last arg in `build_encode_args`.
            let out = args
                .last()
                .expect("output path must be last arg")
                .to_string();
            // Write synchronously-equivalent async to prove the file is
            // present at `run` completion.
            tokio::fs::write(&out, b"encoded")
                .await
                .map_err(|e| EncoderError::Io(format!("write {out}: {e}")))?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn fanout_encode_awaits_completion_before_returning_paths() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let intermediate = IntermediateOutput {
            path: PathBuf::from("/tmp/interm.mkv"),
            duration_ms: 1000,
            width: 1920,
            height: 1080,
            fps: 60,
        };
        let plan = FanoutPlan::batch(
            vec![OutputFormat::Mp4, OutputFormat::WebM],
            Resolution::R1080p,
            60,
            Quality::Med,
            tmp.path(),
            "clip",
        );

        let outputs = fanout_encode(
            &intermediate,
            &plan,
            || Arc::new(WritingCmd) as Arc<dyn SidecarCommand>,
            HardwareEncoder::Libx264Software,
        )
        .await
        .unwrap();

        assert_eq!(outputs.len(), 2);
        // Each returned path MUST already exist — `fanout_encode` must
        // not resolve before the sidecars finish writing.
        for p in &outputs {
            assert!(
                p.exists(),
                "fanout_encode returned path that does not exist yet: {p:?}"
            );
        }
    }
}

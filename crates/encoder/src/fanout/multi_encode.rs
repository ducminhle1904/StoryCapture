//! Fan-out: FFV1 intermediate → N parallel encoders (Plan 02-10 Task 3).
//!
//! The "smart batch reuse" (D-30): given one intermediate (Task 3
//! upstream) and a [`FanoutPlan`] listing the desired outputs, spawn
//! one FFmpeg sidecar per output in parallel and return the produced
//! file paths once they all complete.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::try_join_all;

use crate::error::{EncoderError, Result};
use crate::fanout::intermediate::IntermediateOutput;
use crate::sidecar::SidecarCommand;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Mp4,
    WebM,
    Gif,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    R720p,
    R1080p,
    R4k,
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
        Resolution::R720p => 1280,
        Resolution::R1080p => 1920,
        Resolution::R4k => 3840,
    }
}

pub fn resolution_height(r: Resolution) -> u32 {
    match r {
        Resolution::R720p => 720,
        Resolution::R1080p => 1080,
        Resolution::R4k => 2160,
    }
}

/// Approximate bitrate selection. Tuned for "good-enough" defaults; the
/// renderer tier picker (Plan 12) will override these per-preset.
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

/// Best H.264 encoder name — defaults to `libopenh264` (LGPL software
/// baseline). Production wires `encoder::probe_encoders()` here; tests
/// pass the default.
pub fn default_h264_encoder() -> &'static str {
    "libopenh264"
}

/// Build the argv for a single MP4/WebM/GIF encode pass. Pure + unit-
/// testable; [`fanout_encode`] calls it per output.
pub fn build_encode_args(
    intermediate: &Path,
    spec: &OutputSpec,
    h264_encoder: &str,
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
            args.push(format!("scale={w}:{h}:flags=lanczos"));
            args.push("-c:v".into());
            args.push(h264_encoder.into());
            args.push("-b:v".into());
            args.push(bitrate_for(spec.resolution, spec.quality, "h264"));
            args.push("-pix_fmt".into());
            args.push("yuv420p".into());
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("128k".into());
            args.push("-movflags".into());
            args.push("+faststart".into());
            args.push("-r".into());
            args.push(spec.fps.to_string());
        }
        OutputFormat::WebM => {
            args.push("-vf".into());
            args.push(format!("scale={w}:{h}:flags=lanczos"));
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
    h264_encoder: &str,
) -> Result<Vec<PathBuf>> {
    let tasks: Vec<_> = plan
        .outputs
        .iter()
        .map(|spec| {
            let cmd = sidecar_factory();
            let input = intermediate.path.clone();
            let spec = spec.clone();
            let h264 = h264_encoder.to_string();
            tokio::spawn(async move {
                let args = build_encode_args(&input, &spec, &h264);
                let _child = cmd.spawn(args).await?;
                // Task 3 pipeline leaves exit-waiting to the caller /
                // Plan 11 host wiring which also streams progress; the
                // fanout contract here is "args were dispatched". See
                // `queue::actor::reconcile_done` for the lifecycle the
                // RenderQueueActor layers on top of this.
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
        assert!(plan.outputs[0].output_path.to_string_lossy().ends_with("clip.mp4"));
        assert!(plan.outputs[1].output_path.to_string_lossy().ends_with("clip.webm"));

        let mp4 = build_encode_args(
            Path::new("/tmp/interm.mkv"),
            &plan.outputs[0],
            "h264_videotoolbox",
        );
        assert!(mp4.iter().any(|a| a == "h264_videotoolbox"));
        let webm = build_encode_args(Path::new("/tmp/interm.mkv"), &plan.outputs[1], "libopenh264");
        assert!(webm.iter().any(|a| a == "libvpx-vp9"));
    }

    #[test]
    fn gif_2pass_palette() {
        let s = spec(OutputFormat::Gif, "/tmp/out.gif");
        let args = build_encode_args(Path::new("/tmp/interm.mkv"), &s, "libopenh264");
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
            move || Arc::new(RecordingCmd { calls: calls_c.clone() }) as Arc<dyn SidecarCommand>,
            "libopenh264",
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
        assert!(mp4_args.contains("libopenh264"));
        assert!(webm_args.contains("libvpx-vp9"));
    }
}

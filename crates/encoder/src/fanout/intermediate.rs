//! FFV1 intermediate tempfile writer.
//!
//! The "smart batch" pipeline renders composite frames ONCE to an FFV1-
//! encoded MKV tempfile, then fans out to N parallel MP4/WebM/GIF encoders
//! each reading that intermediate. This module owns the first step.
//!
//! FFV1 is a lossless intra-only codec — level 3 with `-coder 1 -context 1
//! -g 1 -slicecrc 1 -slices 24` gives per-frame recoverable slices and
//! decent throughput on commodity CPUs.

use std::path::PathBuf;

use effects::emit::FfmpegEmit;
use effects::Graph;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::error::{EncoderError, Result};
use crate::fanout::multi_encode::{bitrate_for, resolution_height, resolution_width, OutputSpec};
use crate::progress::{parse_line, ProgressFrag, RenderProgress, RenderProgressParser};
use crate::sidecar::{read_stderr_tail, sidecar_exit_message, SidecarChild, SidecarCommand};

#[derive(Debug, Clone)]
pub struct IntermediateProgress {
    pub job_id: uuid::Uuid,
    pub tx: mpsc::Sender<RenderProgress>,
    pub start_pct: f32,
    pub end_pct: f32,
}

/// The output of [`render_intermediate`] — the path to the FFV1 file plus
/// the metadata downstream encoders need.
#[derive(Debug, Clone)]
pub struct IntermediateOutput {
    pub path: PathBuf,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// Render `graph` to an FFV1 intermediate at `out_path`. `sidecar_cmd`
/// spawns FFmpeg; the caller owns `out_path` lifetime (typically a
/// `tempfile::NamedTempFile::into_temp_path()` kept across the fanout
/// pass, deleted at the end).
///
/// The caller is expected to supply any `-i` input arguments needed by
/// the AST (source recording, audio inputs, etc.) via `extra_inputs`.
/// `FfmpegEmit` currently returns only a filter_complex string; future
/// work will extend it with structured extra_inputs. Until then callers
/// pass `[[-i, <source.mp4>]]` or similar by hand.
pub async fn render_intermediate(
    graph: &Graph,
    extra_inputs: &[Vec<String>],
    out_path: PathBuf,
    sidecar_cmd: &dyn SidecarCommand,
    duration_ms: u64,
    progress: Option<IntermediateProgress>,
) -> Result<IntermediateOutput> {
    let filter_complex = FfmpegEmit::emit(graph);
    let args = build_intermediate_args(filter_complex, extra_inputs, &out_path, duration_ms);
    run_with_progress(sidecar_cmd, args, duration_ms, progress).await?;
    Ok(IntermediateOutput {
        path: out_path,
        duration_ms,
        width: graph.output_width,
        height: graph.output_height,
        fps: graph.output_fps,
    })
}

/// Build the FFV1 argv. Extracted so unit tests can assert flag shape
/// without spawning a real FFmpeg.
pub fn build_intermediate_args(
    filter_complex: String,
    extra_inputs: &[Vec<String>],
    out_path: &std::path::Path,
    duration_ms: u64,
) -> Vec<String> {
    let has_audio_output = filter_complex.contains("[out_a]");
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
    for ins in extra_inputs {
        for a in ins {
            args.push(a.clone());
        }
    }
    args.push("-filter_complex".into());
    args.push(filter_complex);
    args.push("-map".into());
    args.push("[out_v]".into());
    if has_audio_output {
        args.push("-map".into());
        args.push("[out_a]".into());
    }
    // FFV1 lossless, level 3, per-frame recoverable slices (24), CRC'd.
    args.push("-c:v".into());
    args.push("ffv1".into());
    args.push("-level".into());
    args.push("3".into());
    args.push("-coder".into());
    args.push("1".into());
    args.push("-context".into());
    args.push("1".into());
    args.push("-g".into());
    args.push("1".into());
    args.push("-slicecrc".into());
    args.push("1".into());
    args.push("-slices".into());
    args.push("24".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    push_duration_and_progress_args(&mut args, duration_ms);
    if has_audio_output {
        // Audio: lossless PCM so downstream encoders can re-encode cleanly.
        args.push("-c:a".into());
        args.push("pcm_s16le".into());
    }
    args.push(out_path.to_string_lossy().into_owned());
    args
}

pub async fn render_direct_mp4(
    graph: &Graph,
    extra_inputs: &[Vec<String>],
    spec: &OutputSpec,
    sidecar_cmd: &dyn SidecarCommand,
    h264_encoder: &str,
    duration_ms: u64,
    progress: Option<IntermediateProgress>,
) -> Result<()> {
    let filter_complex = FfmpegEmit::emit(graph);
    let args = build_direct_mp4_args(
        filter_complex,
        extra_inputs,
        spec,
        h264_encoder,
        duration_ms,
    );
    run_with_progress(sidecar_cmd, args, duration_ms, progress).await
}

pub fn build_direct_mp4_args(
    filter_complex: String,
    extra_inputs: &[Vec<String>],
    spec: &OutputSpec,
    h264_encoder: &str,
    duration_ms: u64,
) -> Vec<String> {
    let has_audio_output = filter_complex.contains("[out_a]");
    let filter_complex = format!(
        "{filter_complex};[out_v]scale={}:{}:flags=lanczos[final_v]",
        resolution_width(spec.resolution),
        resolution_height(spec.resolution)
    );
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into()];
    for ins in extra_inputs {
        for a in ins {
            args.push(a.clone());
        }
    }
    args.push("-filter_complex".into());
    args.push(filter_complex);
    args.push("-map".into());
    args.push("[final_v]".into());
    if has_audio_output {
        args.push("-map".into());
        args.push("[out_a]".into());
    }
    args.push("-c:v".into());
    args.push(h264_encoder.into());
    args.push("-b:v".into());
    args.push(bitrate_for(spec.resolution, spec.quality, "h264"));
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    if has_audio_output {
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("128k".into());
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-r".into());
    args.push(spec.fps.to_string());
    push_duration_and_progress_args(&mut args, duration_ms);
    args.push(spec.output_path.to_string_lossy().into_owned());
    args
}

fn push_duration_and_progress_args(args: &mut Vec<String>, duration_ms: u64) {
    if duration_ms > 0 {
        args.push("-t".into());
        args.push(format!("{:.3}", duration_ms as f64 / 1000.0));
    }
    args.push("-nostats".into());
    args.push("-progress".into());
    args.push("pipe:1".into());
}

async fn run_with_progress(
    sidecar_cmd: &dyn SidecarCommand,
    args: Vec<String>,
    duration_ms: u64,
    progress: Option<IntermediateProgress>,
) -> Result<()> {
    let SidecarChild {
        stdin,
        stdout,
        mut stderr,
        mut child,
    } = sidecar_cmd.spawn(args).await?;
    drop(stdin);

    let stderr_task = tokio::spawn(async move { read_stderr_tail(&mut stderr).await });
    let progress_task = tokio::spawn(read_progress_stdout(stdout, duration_ms, progress));

    let status = child
        .wait()
        .await
        .map_err(|e| EncoderError::Io(format!("sidecar wait: {e}")))?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    let progress_result = progress_task
        .await
        .map_err(|e| EncoderError::Io(format!("progress task join: {e}")))?;
    progress_result?;

    if !status.success() {
        return Err(EncoderError::SpawnFailed(sidecar_exit_message(
            status,
            &stderr_tail,
        )));
    }
    Ok(())
}

async fn read_progress_stdout(
    stdout: tokio::process::ChildStdout,
    duration_ms: u64,
    progress: Option<IntermediateProgress>,
) -> Result<()> {
    let Some(progress) = progress else {
        let mut stdout = stdout;
        let mut sink = tokio::io::sink();
        let _ = tokio::io::copy(&mut stdout, &mut sink).await;
        return Ok(());
    };

    let max_duration_ms = duration_guard_ms(duration_ms);
    let mut parser = RenderProgressParser::new(progress.job_id, duration_ms.max(1));
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| EncoderError::Io(format!("read ffmpeg progress: {e}")))?
    {
        if let Some(ProgressFrag::OutTimeMs(raw)) = parse_line(&line) {
            let out_ms = raw / 1000;
            if max_duration_ms > 0 && out_ms > max_duration_ms {
                return Err(EncoderError::Timeout(format!(
                    "ffmpeg output time exceeded expected duration: out={}ms expected={}ms guard={}ms",
                    out_ms, duration_ms, max_duration_ms
                )));
            }
        }
        if let Some(snapshot) = parser.feed_line(&line) {
            let _ = progress.tx.try_send(scale_progress(snapshot, &progress));
        }
    }
    Ok(())
}

fn duration_guard_ms(duration_ms: u64) -> u64 {
    if duration_ms == 0 {
        return 0;
    }
    ((duration_ms as f64 * 1.10) as u64).max(duration_ms + 5_000)
}

fn scale_progress(mut snapshot: RenderProgress, progress: &IntermediateProgress) -> RenderProgress {
    let span = progress.end_pct - progress.start_pct;
    snapshot.pct = progress.start_pct + (snapshot.pct / 100.0) * span;
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffv1_flag_shape() {
        let args = build_intermediate_args(
            "[0:v]null[out_v];[0:a]anull[out_a]".into(),
            &[vec!["-i".into(), "/tmp/in.mp4".into()]],
            std::path::Path::new("/tmp/out.mkv"),
            60_000,
        );
        let joined = args.join(" ");
        assert!(joined.contains("-c:v ffv1"));
        assert!(joined.contains("-level 3"));
        assert!(joined.contains("-slicecrc 1"));
        assert!(joined.contains("-slices 24"));
        assert!(joined.contains("-pix_fmt yuv420p"));
        assert!(joined.contains("-t 60.000"));
        assert!(joined.contains("-progress pipe:1"));
        assert!(joined.contains("-i /tmp/in.mp4"));
        assert!(joined.ends_with("/tmp/out.mkv"));
    }

    #[test]
    fn omits_missing_audio_filter_label() {
        let args = build_intermediate_args(
            "[0:v]null[out_v]".into(),
            &[vec!["-i".into(), "/tmp/in.mp4".into()]],
            std::path::Path::new("/tmp/out.mkv"),
            60_000,
        );
        let joined = args.join(" ");
        assert!(joined.contains("-map [out_v]"), "{joined}");
        assert!(!joined.contains("[out_a]"), "{joined}");
        assert!(!joined.contains("-c:a"), "{joined}");
    }

    #[test]
    fn direct_mp4_args_use_filter_graph_without_intermediate() {
        let spec = OutputSpec {
            format: crate::fanout::OutputFormat::Mp4,
            resolution: crate::fanout::Resolution::R1080p,
            fps: 60,
            quality: crate::fanout::Quality::Med,
            output_path: PathBuf::from("/tmp/out.mp4"),
        };
        let args = build_direct_mp4_args(
            "[0:v]null[out_v]".into(),
            &[vec!["-i".into(), "/tmp/in.mp4".into()]],
            &spec,
            "libx264",
            38_000,
        );
        let joined = args.join(" ");
        assert!(joined.contains("[0:v]null[out_v];[out_v]scale=1920:1080:flags=lanczos[final_v]"));
        assert!(joined.contains("-map [final_v]"));
        assert!(joined.contains("-c:v libx264"));
        assert!(joined.contains("-t 38.000"));
        assert!(joined.ends_with("/tmp/out.mp4"));
    }

    #[test]
    fn duration_guard_allows_small_tolerance() {
        assert_eq!(duration_guard_ms(38_000), 43_000);
        assert_eq!(duration_guard_ms(100_000), 110_000);
    }
}

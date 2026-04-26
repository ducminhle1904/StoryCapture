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

use crate::error::Result;
use crate::sidecar::SidecarCommand;

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
) -> Result<IntermediateOutput> {
    let filter_complex = FfmpegEmit::emit(graph);
    let args = build_intermediate_args(filter_complex, extra_inputs, &out_path);
    let _child = sidecar_cmd.spawn(args).await?;
    // In real use the caller waits on the child's exit + drains stderr.
    // Tests stub the sidecar to capture args; production wires the full
    // progress+wait ladder via the pool.
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
) -> Vec<String> {
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
    // Audio mapping is optional — if the graph has no audio the UI forces
    // a silent anullsrc input upstream so [out_a] always exists.
    args.push("-map".into());
    args.push("[out_a]?".into());
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
    // Audio: lossless PCM so downstream encoders can re-encode cleanly.
    args.push("-c:a".into());
    args.push("pcm_s16le".into());
    args.push(out_path.to_string_lossy().into_owned());
    args
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
        );
        let joined = args.join(" ");
        assert!(joined.contains("-c:v ffv1"));
        assert!(joined.contains("-level 3"));
        assert!(joined.contains("-slicecrc 1"));
        assert!(joined.contains("-slices 24"));
        assert!(joined.contains("-pix_fmt yuv420p"));
        assert!(joined.contains("-i /tmp/in.mp4"));
        assert!(joined.ends_with("/tmp/out.mkv"));
    }
}

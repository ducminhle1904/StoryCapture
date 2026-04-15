//! Shared deterministic 1-min reference graph used by:
//!
//!   - `crates/encoder/src/bin/benchmark-render.rs` (EXPORT-06 speed benchmark)
//!   - `crates/encoder/src/bin/generate-psnr-reference.rs` (POST-08 fixture seeder)
//!   - `crates/encoder/tests/psnr_regression.rs`          (POST-08 CI gate)
//!
//! Keeping the builder in one place guarantees the benchmark binary and
//! the regression test render the SAME graph.
//!
//! The graph intentionally uses only effects that are fully wired in the
//! Phase-2 plan chain (Source only until downstream plans stabilise) so
//! the fixture is hermetic — no external recording needed beyond the
//! synthetic MP4 the benchmark script generates on the fly.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use effects::ast::NodeId;
use effects::{Graph, VideoNode};

/// Build the shared reference graph. Width/height/fps are parameters so
/// the PSNR test can render at 1080p30 while the benchmark can run at
/// 1080p60.
pub fn build_reference_graph(source_path: &Path, width: u32, height: u32, fps: u32) -> Graph {
    let mut g = Graph::new(width, height, fps);
    g.video.push(VideoNode::Source {
        id: NodeId::from_bytes([0x01; 16]),
        path: source_path.to_path_buf(),
        pts_offset_ms: 0,
    });
    g
}

/// Fixture JSON payload consumed by `benchmark-render`. Mirrors the
/// contents of `scripts/benchmark/fixtures/1min-reference.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkFixture {
    pub source_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration_ms: u64,
}

impl BenchmarkFixture {
    pub fn build_graph(&self) -> Graph {
        build_reference_graph(&self.source_path, self.width, self.height, self.fps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_graph_is_deterministic() {
        let a = build_reference_graph(Path::new("/tmp/in.mp4"), 1920, 1080, 30);
        let b = build_reference_graph(Path::new("/tmp/in.mp4"), 1920, 1080, 30);
        assert_eq!(a, b);
        assert_eq!(a.output_width, 1920);
        assert_eq!(a.output_fps, 30);
        assert_eq!(a.video.len(), 1);
    }

    #[test]
    fn benchmark_fixture_roundtrips() {
        let f = BenchmarkFixture {
            source_path: PathBuf::from("/tmp/x.mp4"),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_ms: 60_000,
        };
        let j = serde_json::to_string(&f).unwrap();
        let back: BenchmarkFixture = serde_json::from_str(&j).unwrap();
        assert_eq!(f.width, back.width);
        assert_eq!(f.duration_ms, back.duration_ms);
    }
}

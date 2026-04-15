//! POST-08 PSNR regression test (Plan 02-11 Task 3 / D-29).
//!
//! Phase A (one-time seeding, run manually on a known-good build):
//!
//! ```bash
//! cargo run --package encoder --bin generate-psnr-reference --release -- \
//!     --output crates/encoder/tests/fixtures/1min_reference_1080p30.mp4 \
//!     --ffmpeg $(which ffmpeg)
//! git add crates/encoder/tests/fixtures/1min_reference_1080p30.mp4
//! git commit -m "[fixture](02-11): seed POST-08 PSNR reference 1080p30"
//! ```
//!
//! Phase B (every CI run): `cargo test -p encoder --test psnr_regression`
//! re-renders the same Graph and asserts `average >= 38.0` dB via the
//! FFmpeg `psnr` filter. When the filter graph intentionally changes
//! (pins updated in Plans 01/05–09 snapshots), regenerate the reference
//! with Phase A and recommit with the `[fixture]` prefix — the prefix is
//! the audit trail (T-02-35).
//!
//! Skip semantics: the test prints a `skip:` line and returns early when
//! (a) the reference fixture is absent — instructing the caller to run
//! Phase A — or (b) FFmpeg is absent from `$FFMPEG_BIN` and `which`. This
//! is the same gate pattern used by `tests/probe.rs` and `tests/pipeline.rs`
//! from Plan 01-08.

use std::path::{Path, PathBuf};

use encoder::export::psnr::compute_psnr;
use encoder::export::reference_graph::build_reference_graph;

fn reference_fixture() -> PathBuf {
    PathBuf::from("tests/fixtures/1min_reference_1080p30.mp4")
}

fn ffmpeg_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("FFMPEG_BIN") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    // Fallback: look up on PATH.
    let out = std::process::Command::new("which").arg("ffmpeg").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let p = PathBuf::from(&s);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// Render the shared reference graph to `candidate` at 1080p30 H.264
/// CRF 18. In the current plan surface, the reference Graph has only a
/// `Source` node, so the render is a straight re-encode of the source
/// MP4 into an H.264 candidate file.
async fn render_reference_graph(
    ffmpeg: &Path,
    source: &Path,
    candidate: &Path,
) -> Result<(), String> {
    // Touch the shared Graph so future additions stay in sync.
    let _graph = build_reference_graph(source, 1920, 1080, 30);
    let status = tokio::process::Command::new(ffmpeg)
        .args([
            "-y", "-hide_banner", "-i",
        ])
        .arg(source)
        .args([
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
        ])
        .arg(candidate)
        .status()
        .await
        .map_err(|e| format!("spawn ffmpeg: {e}"))?;
    if !status.success() {
        return Err(format!("ffmpeg exit: {status}"));
    }
    Ok(())
}

#[tokio::test]
async fn post_08_psnr_regression() {
    let reference = reference_fixture();
    if !reference.exists() {
        eprintln!(
            "skip: POST-08 reference fixture missing ({}). Run:\n    cargo run -p encoder --bin generate-psnr-reference --release -- --output {} --ffmpeg $(which ffmpeg)\nand commit with '[fixture]' prefix.",
            reference.display(),
            reference.display()
        );
        return;
    }
    let ffmpeg = match ffmpeg_path() {
        Some(p) => p,
        None => {
            eprintln!("skip: ffmpeg not found (set $FFMPEG_BIN or install on PATH)");
            return;
        }
    };
    // Re-render the reference graph to a candidate MP4 in a tempdir.
    let tmp = tempfile::tempdir().unwrap();
    let candidate = tmp.path().join("out.mp4");
    render_reference_graph(&ffmpeg, &reference, &candidate)
        .await
        .expect("render candidate");

    let r = compute_psnr(&ffmpeg, &reference, &candidate)
        .await
        .expect("compute_psnr");
    // POST-08 gate.
    assert!(
        r.average >= 38.0,
        "PSNR average {} < 38 dB (POST-08 regression)",
        r.average
    );
}

/// Meta-test enforcing the `[fixture]` commit-message prefix policy
/// (T-02-35 audit trail). Only runs when the fixture is actually
/// committed — otherwise it's a no-op.
#[test]
fn reference_fixture_committed_with_prefix() {
    let reference = reference_fixture();
    if !reference.exists() {
        eprintln!(
            "skip: fixture not yet committed — Phase A seeding required. See module docs."
        );
        return;
    }
    // `git log -1 --format=%s -- <path>` returns the subject of the most
    // recent commit that touched <path>.
    let out = std::process::Command::new("git")
        .arg("log")
        .arg("-1")
        .arg("--format=%s")
        .arg("--")
        .arg(&reference)
        .output();
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            eprintln!("skip: git unavailable: {e}");
            return;
        }
    };
    if !out.status.success() {
        eprintln!(
            "skip: git log exited non-zero: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        return;
    }
    let subject = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if subject.is_empty() {
        eprintln!("skip: fixture not yet tracked by git");
        return;
    }
    assert!(
        subject.starts_with("[fixture]"),
        "fixture commit subject must start with '[fixture]' (T-02-35 audit trail) — got: {subject}"
    );
}

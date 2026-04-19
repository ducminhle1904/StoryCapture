//! Integration tests for the Plan 02-11 export orchestrator.
//!
//! These exercise the full `build_batch` + `export_run` chain against an
//! in-memory `project.sqlite` (same pattern as `queue_actor.rs`) so the
//! orchestrator is verified without a real FFmpeg sidecar.

use std::path::PathBuf;
use std::sync::Arc;

use encoder::export::batch::{build_batch, BatchExportRequest};
use encoder::export::format::OutputFormat;
use encoder::export::orchestrator::{export_run, ExportRequest};
use encoder::export::psnr::{compute_psnr, parse_psnr_stats};
use encoder::export::quality::Quality;
use encoder::export::reference_graph::BenchmarkFixture;
use encoder::export::resolution::Resolution;
use rusqlite::Connection;
use storage::migrations::project as project_migrations;
use storage::repos::render_job_repo;
use tokio::sync::Mutex;

fn fresh_db() -> Arc<Mutex<Connection>> {
    let mut c = Connection::open_in_memory().unwrap();
    project_migrations::migrations().to_latest(&mut c).unwrap();
    Arc::new(Mutex::new(c))
}

#[tokio::test]
async fn export_run_enqueues_three_jobs_with_shared_batch_id() {
    let tmp = tempfile::tempdir().unwrap();
    let db = fresh_db();
    let specs = build_batch(&BatchExportRequest {
        outputs: vec![
            (OutputFormat::Mp4, Resolution::R1080p, 60, Quality::Med),
            (OutputFormat::WebM, Resolution::R1080p, 30, Quality::High),
            (OutputFormat::Gif, Resolution::R720p, 24, Quality::Low),
        ],
        out_folder: tmp.path().to_path_buf(),
        base_name: "integration".into(),
    })
    .unwrap();
    let batch_id = specs[0].batch_id;

    let req = ExportRequest {
        story_id: "story-A".into(),
        graph: effects::Graph::new(1920, 1080, 60),
        outputs: specs,
        priority: 7,
        output_folder: tmp.path().to_path_buf(),
        preset_id: None,
    };
    let result = export_run(req, None, &db).await.unwrap();
    assert_eq!(result.job_ids.len(), 3);
    assert_eq!(result.batch_id, batch_id);

    // All three rows live in storage with the expected batch_id + priority.
    let conn = db.lock().await;
    let rows = render_job_repo::list_by_batch(&conn, &batch_id.to_string()).unwrap();
    assert_eq!(rows.len(), 3);
    for r in &rows {
        assert_eq!(r.priority, 7);
        assert_eq!(r.story_id, "story-A");
    }
    // Graph snapshot on disk.
    assert!(result.graph_snapshot_path.exists());
    // And the three output formats distinct.
    let mut fmts: Vec<String> = rows.iter().map(|r| r.format.clone()).collect();
    fmts.sort();
    assert_eq!(fmts, vec!["gif".to_string(), "mp4".into(), "webm".into()]);
}

#[tokio::test]
async fn export_run_rejects_mismatched_batch_id() {
    use uuid::Uuid;
    let tmp = tempfile::tempdir().unwrap();
    let db = fresh_db();
    // Hand-craft two specs with different batch_ids (bypassing build_batch).
    use encoder::export::batch::OutputSpec;
    let specs = vec![
        OutputSpec {
            id: Uuid::new_v4(),
            batch_id: Uuid::now_v7(),
            format: OutputFormat::Mp4,
            resolution: Resolution::R1080p,
            fps: 60,
            quality: Quality::Med,
            output_path: tmp.path().join("a.mp4"),
        },
        OutputSpec {
            id: Uuid::new_v4(),
            batch_id: Uuid::now_v7(),
            format: OutputFormat::WebM,
            resolution: Resolution::R1080p,
            fps: 30,
            quality: Quality::Med,
            output_path: tmp.path().join("a.webm"),
        },
    ];
    let req = ExportRequest {
        story_id: "x".into(),
        graph: effects::Graph::new(1920, 1080, 60),
        outputs: specs,
        priority: 0,
        output_folder: tmp.path().to_path_buf(),
        preset_id: None,
    };
    assert!(export_run(req, None, &db).await.is_err());
}

#[test]
fn benchmark_fixture_json_roundtrips() {
    let path = PathBuf::from("../../scripts/benchmark/fixtures/1min-reference.json");
    // Accept either layout depending on the test runner's CWD. When running
    // `cargo test -p encoder` the CWD is the crate root, which makes the
    // path relative to `crates/encoder/`. The scripts live at repo root
    // (`../../scripts/...`). Fall back to a CWD-relative probe.
    let abs = if path.exists() {
        path
    } else {
        PathBuf::from("scripts/benchmark/fixtures/1min-reference.json")
    };
    assert!(
        abs.exists(),
        "fixture not found at either relative candidate; run from repo root or crate root"
    );
    let raw = std::fs::read_to_string(&abs).unwrap();
    let f: BenchmarkFixture = serde_json::from_str(&raw).unwrap();
    assert_eq!(f.width, 1920);
    assert_eq!(f.height, 1080);
    assert_eq!(f.fps, 60);
    assert_eq!(f.duration_ms, 60_000);
    let graph = f.build_graph();
    assert_eq!(graph.output_width, 1920);
}

#[test]
fn psnr_identical_parse_yields_high_score() {
    // Synthetic stderr copied from a real ffmpeg psnr run on identical
    // inputs. We assert the parser extracts the average correctly.
    let s = "\
Parsed_psnr_0 @ 0x1 PSNR y:inf u:inf v:inf average:inf min:inf max:inf\n\
Parsed_psnr_0 @ 0x1 PSNR y:45.1 u:50.2 v:50.2 average:46.3 min:30.1 max:60.0\n";
    let r = parse_psnr_stats(s).unwrap();
    assert!(r.average >= 38.0, "expected >= 38 dB, got {}", r.average);
}

#[tokio::test]
async fn compute_psnr_errors_on_missing_ffmpeg() {
    let missing = PathBuf::from("/nonexistent/ffmpeg-does-not-exist");
    let a = tempfile::NamedTempFile::new().unwrap();
    let b = tempfile::NamedTempFile::new().unwrap();
    let r = compute_psnr(&missing, a.path(), b.path()).await;
    assert!(r.is_err());
}

/// Smoke-test the benchmark-render binary with `--dry-run`. Spawns the
/// compiled binary via `cargo run` only if `cargo` is on PATH (standard
/// in dev + CI environments); otherwise prints a skip message.
#[test]
fn benchmark_render_dry_run() {
    // Locate the compiled binary; `cargo test` builds both bins because
    // we run `cargo test --package encoder`. Cargo places them under
    // `target/debug/benchmark-render`.
    let candidates = [std::env::current_exe().ok().and_then(|p| {
        // current_exe -> target/debug/deps/<testbin>-hash
        p.parent()
            .and_then(|d| d.parent())
            .map(|td| td.join("benchmark-render"))
    })];
    let bin = match candidates.into_iter().flatten().find(|p| p.exists()) {
        Some(p) => p,
        None => {
            eprintln!("skip: benchmark-render binary not built yet in target/debug/");
            return;
        }
    };
    let fixture = PathBuf::from("../../scripts/benchmark/fixtures/1min-reference.json");
    if !fixture.exists() {
        eprintln!("skip: fixture missing");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let out = std::process::Command::new(&bin)
        .arg("--fixture")
        .arg(&fixture)
        .arg("--out-dir")
        .arg(tmp.path())
        .arg("--formats")
        .arg("mp4,webm")
        .arg("--dry-run")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "benchmark-render dry-run failed: stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("dry_run OK"), "stdout: {stdout}");
}

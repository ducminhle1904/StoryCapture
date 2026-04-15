//! 30-minute memory-stability soak (CAP-05, PITFALLS §8).
//!
//! Gated behind both `--features real-capture` and `#[ignore]` so a normal
//! `cargo test` never starts a 30-min capture — only the dedicated CI
//! workflow (`.github/workflows/capture-soak.yml`) flips both switches.
//!
//! Asserts:
//!   - peak RSS stays under 800 MB (CAP-05 budget)
//!   - linear growth over the run is under 100 MB (catches IOSurface /
//!     ID3D11Texture2D refcount leaks)
//!
//! Writes a `target/tmp/rss-samples.csv` artifact for the CI run to
//! upload, so a regression's RSS curve is reviewable post-mortem.

#![cfg(feature = "real-capture")]

use capture::{pick_default_backend, ByteBoundedQueue, CaptureConfig, CapturePipeline, Frame};
use std::fs::{create_dir_all, File};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use sysinfo::{Pid, System};
use tokio::sync::mpsc;

const SOAK_DURATION_SEC: u64 = 30 * 60; // 30 min
const SAMPLE_INTERVAL_SEC: u64 = 30;
const PEAK_RSS_BUDGET: u64 = 800 * 1024 * 1024; // 800 MB
const LEAK_GROWTH_BUDGET: u64 = 100 * 1024 * 1024; // 100 MB

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn thirty_minute_memory_stability() {
    // Soak intentionally avoids `tracing_subscriber` to keep the
    // dev-dependency surface small; uses eprintln! for sample logging.
    let displays = capture::enumerate_displays().expect("enumerate displays");
    let primary = displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| displays.first())
        .expect("at least one display")
        .clone();
    eprintln!(
        "soak: capturing {} ({}x{} @ {:.2}x)",
        primary.name, primary.width_px, primary.height_px, primary.scale_factor
    );

    let cfg = CaptureConfig::new(primary.id);
    let backend = pick_default_backend(&cfg);
    let queue = ByteBoundedQueue::new(ByteBoundedQueue::DEFAULT_CAP_BYTES);
    let mut pipeline = CapturePipeline::new(backend, queue.clone());
    let (tx, mut rx) = mpsc::channel::<Frame>(64);
    pipeline.start(cfg, tx).await.expect("start capture");

    // Drain consumer in the background so frames flow and the queue
    // doesn't artificially fill up — we want to measure the BACKEND's
    // memory behavior, not back-pressure-induced retention.
    let drain = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            // Drop immediately — drop impl on FrameData::NativeMacOS /
            // NativeWindows triggers CFRelease / Release. This is the
            // central thing the soak validates.
            drop(frame);
        }
    });

    let mut sys = System::new();
    let pid = Pid::from_u32(std::process::id());
    let mut samples: Vec<(u64, u64)> = Vec::new(); // (elapsed_sec, rss_bytes)

    let start = Instant::now();
    while start.elapsed().as_secs() < SOAK_DURATION_SEC {
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            true,
            sysinfo::ProcessRefreshKind::new().with_memory(),
        );
        let rss = sys
            .process(pid)
            .map(|p| p.memory())
            .unwrap_or(0);
        let elapsed = start.elapsed().as_secs();
        samples.push((elapsed, rss));
        eprintln!("t={}s rss={} MB drops={}", elapsed, rss / (1024 * 1024), queue.stats().dropped_frames);
        tokio::time::sleep(Duration::from_secs(SAMPLE_INTERVAL_SEC)).await;
    }

    // Stop capture cleanly so any buffered frames Drop and the backend
    // releases its session before we measure final RSS.
    let stats = pipeline.stop().await.expect("stop capture");
    drain.await.ok();

    eprintln!(
        "soak: capture stopped — frames_delivered={} duration_ms={}",
        stats.frames_delivered, stats.duration_ms
    );

    // Write CSV artifact even on failure for CI debugging.
    let artifact_dir = PathBuf::from("target/tmp");
    create_dir_all(&artifact_dir).ok();
    let csv = artifact_dir.join("rss-samples.csv");
    let mut f = File::create(&csv).expect("create csv");
    writeln!(f, "elapsed_sec,rss_bytes").unwrap();
    for (t, rss) in &samples {
        writeln!(f, "{},{}", t, rss).unwrap();
    }

    // === Assertions ===
    let peak = samples.iter().map(|(_, r)| *r).max().unwrap_or(0);
    let first = samples.first().map(|(_, r)| *r).unwrap_or(0);
    let last = samples.last().map(|(_, r)| *r).unwrap_or(0);
    let growth = last.saturating_sub(first);

    eprintln!(
        "soak verdict: peak={} MB (budget {} MB)  growth={} MB (budget {} MB)",
        peak / (1024 * 1024),
        PEAK_RSS_BUDGET / (1024 * 1024),
        growth / (1024 * 1024),
        LEAK_GROWTH_BUDGET / (1024 * 1024)
    );

    assert!(
        peak < PEAK_RSS_BUDGET,
        "peak RSS {} MB exceeded {} MB budget (CAP-05)",
        peak / (1024 * 1024),
        PEAK_RSS_BUDGET / (1024 * 1024)
    );
    assert!(
        growth < LEAK_GROWTH_BUDGET,
        "RSS grew {} MB across the run (>{} MB budget); likely IOSurface / ID3D11Texture2D leak",
        growth / (1024 * 1024),
        LEAK_GROWTH_BUDGET / (1024 * 1024)
    );
}

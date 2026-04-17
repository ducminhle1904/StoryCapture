//! Real-capture integration tests (Plan 05-01 Wave 0, Task 2 makes them green).
//!
//! These compile under `--features real-capture` and are `#[ignore]`-marked so
//! `cargo test --no-run` verifies they build in CI without actually hitting
//! ScreenCaptureKit (which requires a real display + TCC grant).

#![cfg(all(target_os = "macos", feature = "real-capture"))]

use capture::{
    CaptureBackend, CaptureConfig, CaptureTarget, DisplayId, Frame, SckBackend, WindowId,
};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

/// Stream at least one frame from the primary display within 2 seconds.
#[tokio::test]
#[ignore = "requires Screen Recording TCC grant — run manually"]
async fn sck_display_smoke() {
    let mut backend = SckBackend::new().expect("SckBackend::new");
    let displays = capture::enumerate_displays().expect("enumerate_displays");
    let primary = displays
        .iter()
        .find(|d| d.is_primary)
        .unwrap_or(&displays[0])
        .id;
    let mut cfg = CaptureConfig::new_for_target(CaptureTarget::Display { display_id: primary });
    cfg.fps_target = 30;
    let (tx, mut rx) = mpsc::channel::<Frame>(16);
    backend.start(cfg, tx).await.expect("start");
    let frame = timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("frame timeout")
        .expect("sender closed");
    assert!(frame.width_px > 0 && frame.height_px > 0);
    backend.stop().await.expect("stop");
}

/// Stream at least one frame from a known window (Finder Dock/Desktop).
#[tokio::test]
#[ignore = "requires Screen Recording TCC grant — run manually"]
async fn sck_window_smoke() {
    use capture::macos::window::list_windows;
    let windows = list_windows().expect("list_windows");
    // Pick any window belonging to Finder or similar always-running system app.
    let target_window = windows
        .iter()
        .find(|w| w.app_name == "Finder")
        .or_else(|| windows.first())
        .expect("no windows to target");
    let window_id = WindowId(u64::from(target_window.window_id));

    let mut backend = SckBackend::new().expect("SckBackend::new");
    let mut cfg = CaptureConfig::new_for_target(CaptureTarget::Window { window_id });
    cfg.fps_target = 30;
    let (tx, mut rx) = mpsc::channel::<Frame>(16);
    backend.start(cfg, tx).await.expect("start");
    let frame = timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("frame timeout")
        .expect("sender closed");
    assert!(frame.width_px > 0 && frame.height_px > 0);
    backend.stop().await.expect("stop");
}

/// Target window close must surface as a `BackendFailed` event within 500ms.
///
/// We simulate this by starting against a window, then dropping backend.stop()
/// and asserting the delegate-driven event channel signals failure. This
/// test's full assertion requires the orchestrator from Task 3 — for Wave 0
/// we just ensure it compiles and ignore.
#[tokio::test]
#[ignore = "requires helper window harness — implemented in Task 3"]
async fn sck_window_close_recovery() {
    // Full implementation lands in Task 3 where the orchestrator wires the
    // delegate error path into `CaptureEvent::BackendFailed`.
    let _ = DisplayId(0);
}

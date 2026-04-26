//! Real-capture integration tests.
//!
//! These compile under `--features real-capture-windows` and are `#[ignore]`-marked
//! so `cargo test --no-run` verifies they build in CI without actually hitting
//! Windows.Graphics.Capture (which requires a graphical session + notepad.exe
//! at runtime). Operators run them with `--ignored` on a Windows VM.
//!
//! # Running on a Windows VM
//!
//! ```powershell
//! # Prereqs: Rust toolchain, a logged-in graphical session, notepad.exe on PATH,
//! # the Playwright sidecar available for `wgc_find_window_by_pid_chromium`.
//! cargo test -p capture --target x86_64-pc-windows-msvc \
//!   --features real-capture-windows -- --ignored --test-threads=1
//! ```

#![cfg(all(target_os = "windows", feature = "real-capture-windows"))]

use capture::{
    CaptureBackend, CaptureConfig, CaptureTarget, DisplayId, Frame, WgcBackend, WindowId,
};
use std::process::Command;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

/// Stream at least one frame from the primary monitor within 2 seconds.
#[tokio::test]
#[ignore = "requires graphical Windows session — run manually on a VM"]
async fn wgc_monitor_smoke() {
    let mut backend = WgcBackend::new().expect("WgcBackend::new");
    let displays = capture::enumerate_displays().expect("enumerate_displays");
    let primary = displays
        .iter()
        .find(|d| d.is_primary)
        .unwrap_or(&displays[0])
        .id;
    let mut cfg = CaptureConfig::new_for_target(CaptureTarget::Display {
        display_id: primary,
    });
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

/// Spawn Notepad, capture its window for one frame, tear down.
#[tokio::test]
#[ignore = "requires graphical Windows session + notepad.exe"]
async fn wgc_window_smoke() {
    let mut notepad = Command::new("notepad.exe")
        .spawn()
        .expect("spawn notepad.exe");
    // Give Notepad a moment to present its top-level window.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let pid = notepad.id() as i32;
    let hwnd_opt = capture::windows::window::find_window_by_pid(pid, None)
        .await
        .expect("find_window_by_pid");
    let hwnd = hwnd_opt.expect("notepad hwnd should be enumerable");
    let window_id = WindowId(hwnd as u64);

    let mut backend = WgcBackend::new().expect("WgcBackend::new");
    let mut cfg = CaptureConfig::new_for_target(CaptureTarget::Window { window_id });
    cfg.fps_target = 30;
    let (tx, mut rx) = mpsc::channel::<Frame>(16);
    let start_res = backend.start(cfg, tx).await;
    let frame_res = if start_res.is_ok() {
        timeout(Duration::from_secs(2), rx.recv()).await
    } else {
        Ok(None)
    };
    let _ = notepad.kill();
    let _ = notepad.wait();

    start_res.expect("start");
    let frame = frame_res.expect("frame timeout").expect("sender closed");
    assert!(frame.width_px > 0 && frame.height_px > 0);
    backend.stop().await.expect("stop");
}

/// Start capture, then close the target window; the `on_closed` callback
/// must route a `CaptureEvent::BackendFailed` through the orchestrator
/// within 500ms. This test drives the backend directly, listening on the
/// event sink registered before `start`.
#[tokio::test]
#[ignore = "requires graphical Windows session + notepad.exe"]
async fn wgc_window_close_recovery() {
    let mut notepad = Command::new("notepad.exe")
        .spawn()
        .expect("spawn notepad.exe");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let pid = notepad.id() as i32;
    let hwnd = capture::windows::window::find_window_by_pid(pid, None)
        .await
        .expect("find_window_by_pid")
        .expect("notepad hwnd");
    let window_id = WindowId(hwnd as u64);

    let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<capture::CaptureEvent>();
    let mut backend = WgcBackend::new().expect("WgcBackend::new");
    backend.set_event_sink(evt_tx);

    let mut cfg = CaptureConfig::new_for_target(CaptureTarget::Window { window_id });
    cfg.fps_target = 30;
    let (tx, mut _rx) = mpsc::channel::<Frame>(16);
    backend.start(cfg, tx).await.expect("start");

    // Wait for a frame, then kill Notepad to trigger on_closed.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = notepad.kill();
    let _ = notepad.wait();

    // Expect a BackendFailed event within 500ms of the window closing.
    let evt = timeout(Duration::from_millis(500), evt_rx.recv())
        .await
        .expect("no event within 500ms")
        .expect("event sink dropped");
    match evt {
        capture::CaptureEvent::BackendFailed { .. } => {}
        other => panic!("expected BackendFailed, got {other:?}"),
    }
    let _ = backend.stop().await;
}

/// Spawn a headed Chromium via Playwright and confirm pid→HWND resolves
/// within 1s. The Playwright sidecar helper is shared with the launcher —
/// this test exercises the cross-cutting pid-resolution path, not a full
/// Playwright launch. When the helper is unavailable (not bundled in this
/// worktree), we skip gracefully via an env var.
#[tokio::test]
#[ignore = "requires Playwright sidecar helper (Plan 05-02)"]
async fn wgc_find_window_by_pid_chromium() {
    let sidecar_pid: i32 = match std::env::var("STORYCAPTURE_TEST_CHROMIUM_PID") {
        Ok(v) => v.parse().expect("pid env parse"),
        Err(_) => {
            eprintln!(
                "skipping: set STORYCAPTURE_TEST_CHROMIUM_PID to a live Chromium browser pid"
            );
            return;
        }
    };
    let start = std::time::Instant::now();
    let hwnd = capture::windows::window::find_window_by_pid(sidecar_pid, Some("Chrome"))
        .await
        .expect("find_window_by_pid")
        .expect("chromium hwnd");
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(1),
        "pid→HWND took {elapsed:?} (> 1s budget)"
    );
    assert!(hwnd != 0);
}

/// Enumeration must exclude StoryCapture's own HWNDs (T-05-03-01 / parity
/// with macOS T-05-01-02).
#[tokio::test]
#[ignore = "requires graphical Windows session"]
async fn list_windows_excludes_self_windows() {
    let self_pid = std::process::id() as i32;
    let windows = capture::windows::window::list_windows().expect("list_windows");
    for w in &windows {
        assert_ne!(
            w.pid, self_pid,
            "list_windows leaked self-pid {self_pid} (hwnd={})",
            w.window_id
        );
    }
    // We also require that enumeration returns *something* (desktop host
    // is not empty). If this ever runs on a truly-headless runner it would
    // fail — matches the operator-VM constraint.
    assert!(!windows.is_empty(), "enumeration returned zero windows");
}

// Anchor: exercise DisplayId construction so clippy doesn't complain when
// the CI compile path runs with this feature off in non-test builds.
#[allow(dead_code)]
fn _display_id_anchor() {
    let _ = DisplayId(0);
}

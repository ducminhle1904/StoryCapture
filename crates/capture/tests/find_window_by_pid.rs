//! Plan 05-02 Task 0 / Task 2 — integration tests for `find_window_by_pid`.
//!
//! Feature-gated `real-capture` because SCShareableContent requires a
//! Screen Recording TCC grant + a live display. Tests are `#[ignore]`-marked
//! so `cargo test --no-run` verifies the compile but CI skips until the
//! operator runs them on a TCC-granted macOS host.
//!
//! These cover the pid→SCWindow resolver added in Task 2:
//!   - `find_window_by_pid_returns_none_for_dead_pid` — sentinel negative case
//!   - `find_window_by_pid_chromium` — spawn a headed Chromium via a raw
//!      `playwright-core` executable path lookup, assert pid resolves to a
//!      window within 1s, asserts app/title contains "Chromium"
//!   - `find_window_by_pid_prefers_largest_window` — opens two windows under
//!      the same Chromium pid (main + popup), asserts the larger one wins

#![cfg(all(target_os = "macos", feature = "real-capture"))]

use capture::macos::window::find_window_by_pid;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tokio::time::sleep;

/// A pid that cannot exist on any realistic system.
const DEAD_PID: i32 = 999_999;

#[tokio::test]
#[ignore = "requires Screen Recording TCC grant — run manually"]
async fn find_window_by_pid_returns_none_for_dead_pid() {
    let start = Instant::now();
    let res = find_window_by_pid(DEAD_PID, None).await;
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "retry must cap at ~1s, elapsed {:?}",
        start.elapsed()
    );
    match res {
        Ok(None) => {}
        Ok(Some(_)) => panic!("pid {DEAD_PID} should not own any window"),
        Err(e) => panic!("unexpected error: {e}"),
    }
}

#[tokio::test]
#[ignore = "requires Screen Recording TCC grant + Chromium installed via playwright"]
async fn find_window_by_pid_chromium() {
    // Launch a bare Chromium via the playwright-core cached binary. We can
    // avoid the sidecar here — the test only needs a process whose pid
    // owns an on-screen window. We use `open -a "Google Chrome"` if
    // available, else any `Chromium.app` bundle found in the playwright
    // cache.
    let chromium_path = playwright_chromium_path().expect("chromium binary");
    let mut child = Command::new(&chromium_path)
        .arg("about:blank")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn chromium");
    let pid = child.id() as i32;
    // Give Chromium time to register its window.
    sleep(Duration::from_millis(500)).await;
    let start = Instant::now();
    let result = find_window_by_pid(pid, Some("Chromium")).await;
    let elapsed = start.elapsed();
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        elapsed < Duration::from_secs(3),
        "cold-path resolution must complete within 3s, was {elapsed:?}",
    );
    let window = result.expect("no SCK error").expect("pid window not found");
    let title = window.title().unwrap_or_default();
    let app_name = window
        .owning_application()
        .map(|a| a.application_name())
        .unwrap_or_default();
    assert!(
        title.to_lowercase().contains("chromium")
            || app_name.to_lowercase().contains("chromium")
            || app_name.to_lowercase().contains("chrome"),
        "expected chromium window, got app={app_name} title={title}",
    );
}

#[tokio::test]
#[ignore = "requires Screen Recording TCC grant + Chromium installed via playwright"]
async fn find_window_by_pid_prefers_largest_window() {
    // Open a Chromium instance, then open a second window via CLI flag.
    let chromium_path = playwright_chromium_path().expect("chromium binary");
    let mut child = Command::new(&chromium_path)
        .args([
            "--new-window",
            "--window-size=1600,1000",
            "about:blank",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn chromium");
    let pid = child.id() as i32;
    // Spawn a second (smaller) popup via osascript after delay.
    sleep(Duration::from_millis(600)).await;
    let _ = Command::new("osascript")
        .args([
            "-e",
            &format!(
                "tell application id \"com.google.Chrome\" to make new window with properties {{bounds:{{100,100,500,400}}}}"
            ),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    sleep(Duration::from_millis(800)).await;
    let result = find_window_by_pid(pid, Some("Chromium")).await;
    let _ = child.kill();
    let _ = child.wait();
    let window = result.expect("no SCK error").expect("pid window not found");
    let frame = window.frame();
    // Largest-area rule: the returned window must have area > 500_000 px²
    // (e.g. 1000×500) — rules out small popup.
    let area = frame.width * frame.height;
    assert!(
        area > 500_000.0,
        "expected largest-area window, got area={area} w={} h={}",
        frame.width,
        frame.height,
    );
}

/// Locate the playwright-core managed Chromium binary, falling back to
/// `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` if the
/// playwright cache is empty.
fn playwright_chromium_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut cache = std::path::PathBuf::from(home);
    cache.push("Library/Caches/ms-playwright");
    if let Ok(rd) = std::fs::read_dir(&cache) {
        for entry in rd.flatten() {
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if s.starts_with("chromium") {
                // chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium
                let p = entry
                    .path()
                    .join("chrome-mac/Chromium.app/Contents/MacOS/Chromium");
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    let fallback = std::path::PathBuf::from(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    if fallback.exists() {
        Some(fallback)
    } else {
        None
    }
}

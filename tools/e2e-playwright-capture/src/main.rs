//! Smoke test for Playwright pid -> window resolution -> ScreenCaptureKit capture.
//!
//! Launches the Playwright sidecar, opens a visible Chromium window, captures
//! about five seconds from that window, and asserts the frame stream looks sane.

use anyhow::{anyhow, Context, Result};
use automation::{BrowserDriver, LaunchConfig, PlaywrightSidecarDriver};
use capture::{CaptureBackend, CaptureConfig, CaptureTarget, Frame, SckBackend};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::mpsc;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let out_path = PathBuf::from("/tmp/sc-e2e-playwright.mp4");
    if out_path.exists() {
        let _ = std::fs::remove_file(&out_path);
    }

    let start = Instant::now();
    tracing::info!("e2e-playwright-capture: start");

    // Spawn sidecar.
    let sidecar_script = workspace_root()?.join("scripts/playwright-sidecar/server.mjs");
    if !sidecar_script.exists() {
        return Err(anyhow!(
            "sidecar script not found at {}",
            sidecar_script.display()
        ));
    }
    let child = Command::new("node")
        .arg(&sidecar_script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("spawn node sidecar")?;

    let mut driver =
        PlaywrightSidecarDriver::from_child(child).map_err(|e| anyhow!("wrap sidecar: {e}"))?;

    // Launch visible Chromium.
    let cfg = LaunchConfig {
        url: None,
        viewport: story_parser::Viewport {
            width: 1280,
            height: 800,
        },
        theme: story_parser::Theme::Auto,
        base_url: None,
        headless: false, // SCK only captures visible windows.
        download_dir: PathBuf::from("/tmp"),
        executable: None,
        args: Vec::new(),
    };
    driver
        .launch(cfg)
        .await
        .map_err(|e| anyhow!("driver launch: {e}"))?;
    driver
        .goto("about:blank")
        .await
        .map_err(|e| anyhow!("goto about:blank: {e}"))?;
    tracing::info!(elapsed = ?start.elapsed(), "sidecar launched + navigated");

    // Resolve browser pid.
    let info = driver
        .browser_process()
        .await
        .map_err(|e| anyhow!("browser_process: {e}"))?;
    let pid = info.pid.ok_or_else(|| {
        anyhow!(
            "sidecar returned null pid (remote-browser? reason={:?})",
            info.reason
        )
    })?;
    tracing::info!(pid, "Playwright Chromium pid resolved");

    // Best-effort window lookup; backend start still does the real retry loop.
    #[cfg(target_os = "macos")]
    {
        match capture::macos::window::find_window_by_pid(pid, Some("Chromium")).await {
            Ok(Some(id)) => {
                tracing::info!(window_id = id.0, "resolved WindowId");
            }
            Ok(None) => {
                tracing::warn!("find_window_by_pid returned None — backend will retry");
            }
            Err(e) => return Err(anyhow!("find_window_by_pid: {e}")),
        }
    }

    // Capture ~5s from the Playwright window.
    #[cfg(target_os = "macos")]
    {
        let mut backend = SckBackend::new().map_err(|e| anyhow!("SckBackend::new: {e}"))?;
        let cap_cfg = CaptureConfig {
            target: CaptureTarget::WindowByPid {
                pid,
                title_hint: Some("Chromium".to_string()),
            },
            include_cursor: true,
            fps_target: 30,
            pixel_format: capture::PixelFormat::Bgra,
            queue_cap_bytes: 64 * 1024 * 1024,
        };
        let (tx, mut rx) = mpsc::channel::<Frame>(128);
        backend
            .start(cap_cfg, tx)
            .await
            .map_err(|e| anyhow!("SckBackend::start: {e}"))?;

        let record_deadline = Instant::now() + Duration::from_secs(5);
        let mut frame_count = 0u64;
        let mut first_width = 0u32;
        let mut first_height = 0u32;
        while Instant::now() < record_deadline {
            match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
                Ok(Some(f)) => {
                    if frame_count == 0 {
                        first_width = f.width_px;
                        first_height = f.height_px;
                    }
                    frame_count += 1;
                }
                Ok(None) => break,
                Err(_) => {
                    // Allow brief gaps until the overall deadline.
                    continue;
                }
            }
        }
        let stats = backend
            .stop()
            .await
            .map_err(|e| anyhow!("backend stop: {e}"))?;
        tracing::info!(
            frame_count,
            width = first_width,
            height = first_height,
            delivered = stats.frames_delivered,
            dropped = stats.frames_dropped,
            duration_ms = stats.duration_ms,
            "capture complete"
        );

        // Treat frame count as the smoke-test signal.
        const MIN_FRAMES: u64 = 120;
        if frame_count < MIN_FRAMES {
            return Err(anyhow!(
                "captured only {frame_count} frames; expected ≥{MIN_FRAMES} (5s × 30fps)"
            ));
        }
        if first_width < 400 || first_height < 400 {
            return Err(anyhow!(
                "captured dimensions too small: {first_width}×{first_height}"
            ));
        }
    }

    // Close Playwright.
    let _ = driver.close().await;
    tracing::info!(total = ?start.elapsed(), "e2e-playwright-capture: SUCCESS");
    Ok(())
}

fn workspace_root() -> Result<PathBuf> {
    // Walk up from tools/e2e-playwright-capture to the repo root.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| anyhow!("workspace root not found from {}", manifest.display()))?;
    Ok(root.to_path_buf())
}

// Logging bridge — `tracing` ↔ `tauri-plugin-log` (D-30).
//
// We use `tracing` everywhere in Rust for spans + structured fields, then
// bridge into `tauri-plugin-log` for file rotation (daily, 7-day retention)
// and platform-correct log directory placement:
//   - macOS:   ~/Library/Logs/com.storycapture.desktop/
//   - Windows: %LOCALAPPDATA%\com.storycapture.desktop\logs\
//   - Linux:   ~/.local/share/com.storycapture.desktop/logs/  (dev-only)
//
// `tracing-log` is wired so any third-party crate using the `log` facade
// flows into the same pipeline.
//
// Telemetry-off by default (D-30): logs are LOCAL ONLY. Phase 5 may add an
// opt-in upload button; nothing in this module talks to the network.

use std::path::Path;

use anyhow::Context;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Initialize tracing-subscriber with:
///  * an env-filter (default `storycapture=info,warn`)
///  * a stdout layer in debug builds
///  * a rolling-file layer (daily rotation) in the platform log dir
///
/// Tauri-plugin-log is configured separately in `lib.rs::run` to write to
/// the same directory; the two are intentionally complementary — `tracing`
/// covers the Rust side with spans, `tauri-plugin-log` exposes a `log:`
/// IPC API for the renderer.
pub fn init(log_dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(log_dir)
        .with_context(|| format!("creating log dir {}", log_dir.display()))?;

    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("storycapture=info,warn"))
        .context("building EnvFilter")?;

    // Daily rotating file appender. We deliberately do NOT use
    // tracing-appender's non-blocking writer here because the worker thread
    // it spawns can outlive the runtime drop and leak file handles on
    // shutdown; the synchronous appender's overhead is negligible for the
    // log volumes a desktop app produces.
    let file_appender = tracing_appender::rolling::daily(log_dir, "storycapture.log");

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(file_appender)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(true);

    let registry = tracing_subscriber::registry().with(filter).with(file_layer);

    #[cfg(debug_assertions)]
    {
        let stdout_layer = tracing_subscriber::fmt::layer()
            .with_writer(std::io::stdout)
            .with_ansi(true)
            .with_target(false);
        registry.with(stdout_layer).try_init()?;
    }

    #[cfg(not(debug_assertions))]
    {
        registry.try_init()?;
    }

    // Bridge log -> tracing (chromiumoxide, hyper, etc. use `log`).
    // Ignore errors: a logger may already be installed in test contexts.
    let _ = tracing_log::LogTracer::init();

    tracing::info!(target: "storycapture::boot", "tracing initialised; log_dir={}", log_dir.display());
    Ok(())
}

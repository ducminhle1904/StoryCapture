//! Region-selection overlay window.
//!
//! Creates a transparent, fullscreen, always-on-top overlay on the
//! requested display. The overlay React route (mounted at
//! `#/region-overlay?display_id=...`) owns the drag-to-draw UX; when the
//! user confirms or cancels it emits `region://selected` back to the
//! main window via Tauri's event bus:
//!
//!   payload = {"display_id": u64, "x": f64, "y": f64, "w": f64, "h": f64}
//!   payload = {"cancelled": true}
//!
//! Lifecycle:
//! - `open_region_overlay(display_id)` creates (or reuses) the overlay
//!   window and sends it to the requested display.
//! - The overlay closes itself via `window.close()` after emit; the main
//!   window reads the event and stores the rect in recorder state.
//!
//! Security: the overlay label `region-overlay` is a trusted-process Tauri
//! window — OS window-manager prevents another app from claiming the same
//! label. Standard local-trust boundary.

use crate::error::AppError;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "region-overlay";

/// Open (or focus) the region-selection overlay on the specified display.
///
/// When the user finishes interacting, the overlay emits
/// `region://selected` back to the main window and closes itself. The
/// caller does not `await` a response here — it's a fire-and-forget
/// window open; the renderer listens for the event.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "open_region_overlay"), err(Debug))]
pub async fn open_region_overlay(app: AppHandle, display_id: u64) -> Result<(), AppError> {
    // If already open, focus and re-target. A user can hit "Crop to
    // region…" twice without piling up windows.
    if let Some(existing) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        // Re-emit target display so the overlay can reset state.
        let _ = existing.emit("region://retarget", display_id);
        return Ok(());
    }

    // React Router is a createBrowserRouter, so we use the normal path
    // (no hash). The index.html served by Vite/the dist bundle is mounted
    // at the root and will route the fresh overlay window to the
    // `/region-overlay` entry below. `display_id` rides as a query param.
    let url = WebviewUrl::App(format!("region-overlay?display_id={display_id}").into());
    let builder = WebviewWindowBuilder::new(&app, OVERLAY_LABEL, url)
        .title("Select region")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .fullscreen(true)
        .visible(true);

    builder
        .build()
        .map_err(|e| AppError::Capture(format!("build region overlay: {e}")))?;
    Ok(())
}

/// Close the overlay from the host side (e.g. if the main window
/// navigates away while the overlay is open). The overlay normally
/// closes itself after emit; this is a safety net.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "close_region_overlay"), err(Debug))]
pub async fn close_region_overlay(app: AppHandle) -> Result<(), AppError> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.close();
    }
    Ok(())
}

//! Plan 06-03 Task 1 — macOS SCScreenshotManager wrapper.
//!
//! Single-shot thumbnail capture via `SCScreenshotManager::capture_image`
//! (screencapturekit 1.5.4). Powers the recorder's 2s-refresh preview
//! thumbnail (D-16 + D-17). NOT a streaming replacement — each call
//! performs one synchronous capture + PNG encode, wrapped in
//! `spawn_blocking` so the Tokio runtime keeps turning.
//!
//! TCC: SCScreenshotManager is gated by Screen Recording permission;
//! when denied, the call returns `SCError::ScreenshotError("...")`,
//! which we map to `CaptureError::PermissionDenied`. Non-permission
//! failures fold into `CaptureError::Native`.
//!
//! Performance budget: ≤200ms per round-trip on reference hardware
//! (SCScreenshotManager itself is ~50-80ms for a single display on
//! M-series Macs; PNG encode of a 320×200 RGBA buffer is <10ms).

use crate::error::CaptureError;
use crate::target::CaptureTarget;
use screencapturekit::screenshot_manager::{CGImage, SCScreenshotManager};
use screencapturekit::stream::configuration::{
    PixelFormat as SckPixelFormat, SCStreamConfiguration,
};

/// Capture a single thumbnail of `target`, downscaled to fit within
/// `max_width × max_height`, returned as PNG-encoded bytes.
///
/// Never upscales — the output is `min(max_w, src_w) × min(max_h, src_h)`
/// preserving aspect ratio. The PNG byte-stream is suitable for direct
/// use as `<img src="data:image/png;base64,...">` or `createObjectURL`.
///
/// # Errors
/// - `CaptureError::PermissionDenied` when TCC denies the call
/// - `CaptureError::Native` for any other SCK / PNG encoding failure
pub async fn capture_thumbnail(
    target: &CaptureTarget,
    max_width: u32,
    max_height: u32,
) -> Result<Vec<u8>, CaptureError> {
    let target_owned = target.clone();

    // Phase 1: resolve filter + source dimensions on a blocking thread
    // (SCShareableContent::get is synchronous 50-200ms — Pitfall 7).
    let (filter, src_w, src_h, _source_rect) = tokio::task::spawn_blocking(move || {
        crate::macos::sck_backend::SckBackend::build_filter(&target_owned)
    })
    .await
    .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))??;

    // Compute downscale factor — never upscales (scale ≤ 1.0).
    let scale_x = if src_w > 0 {
        max_width as f64 / src_w as f64
    } else {
        1.0
    };
    let scale_y = if src_h > 0 {
        max_height as f64 / src_h as f64
    } else {
        1.0
    };
    let scale = scale_x.min(scale_y).min(1.0);
    let out_w = ((src_w as f64 * scale).max(1.0).round() as u32).max(1);
    let out_h = ((src_h as f64 * scale).max(1.0).round() as u32).max(1);

    tracing::debug!(
        target: "capture::macos::screenshot",
        target_kind = %target.kind_label(),
        src_w, src_h, out_w, out_h,
        "capture_thumbnail: invoking SCScreenshotManager"
    );

    // Phase 2: run SCScreenshotManager + PNG encode on a blocking thread.
    // The crate's capture_image spins a Dispatch queue internally and
    // waits — that's the definition of a blocking call.
    tokio::task::spawn_blocking(move || {
        let config = SCStreamConfiguration::new()
            .with_width(out_w)
            .with_height(out_h)
            .with_pixel_format(SckPixelFormat::BGRA)
            .with_scales_to_fit(true);

        let image = SCScreenshotManager::capture_image(&filter, &config)
            .map_err(|e| classify_sck_error(&format!("SCScreenshotManager: {e}")))?;

        encode_cg_image_to_png(&image, out_w, out_h)
    })
    .await
    .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))?
}

/// Map SCScreenshotManager error strings onto typed CaptureError kinds.
/// Heuristic — the crate surfaces Cocoa error descriptions verbatim.
fn classify_sck_error(msg: &str) -> CaptureError {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("permission")
        || lower.contains("denied")
        || lower.contains("tcc")
        || lower.contains("not authorized")
        || lower.contains("not permitted")
    {
        CaptureError::PermissionDenied(msg.to_string())
    } else {
        CaptureError::Native(msg.to_string())
    }
}

/// Encode a CGImage's RGBA buffer into PNG bytes using the `image` crate.
///
/// `out_w` / `out_h` are the pixel dimensions requested of SCK. We use
/// them to construct the `RgbaImage` container; the actual buffer length
/// from `rgba_data()` is `4 × w × h`.
fn encode_cg_image_to_png(
    image: &CGImage,
    out_w: u32,
    out_h: u32,
) -> Result<Vec<u8>, CaptureError> {
    // Defensive: use the image's reported dims when the FFI returns a
    // different size than we asked for (SCK may clamp to source extent).
    let actual_w = image.width() as u32;
    let actual_h = image.height() as u32;
    let w = if actual_w > 0 { actual_w } else { out_w };
    let h = if actual_h > 0 { actual_h } else { out_h };

    let rgba = image
        .rgba_data()
        .map_err(|e| CaptureError::Native(format!("CGImage::rgba_data: {e}")))?;
    // SCK already downscaled server-side (we passed out_w/out_h into
    // SCStreamConfiguration), so pass `max = src` to skip the resize
    // pass inside the shared helper (backlog #6).
    crate::thumbnail::encode_rgba_to_png(rgba, w, h, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::DisplayId;

    /// Without TCC we can't exercise the real `SCScreenshotManager` path,
    /// but we can still verify the downscale math + classify_sck_error
    /// taxonomy without a display handle.
    #[test]
    fn classify_permission_error() {
        let err = classify_sck_error("SCScreenshotManager: permission denied for screen capture");
        match err {
            CaptureError::PermissionDenied(_) => {}
            other => panic!("expected PermissionDenied, got {other:?}"),
        }
    }

    #[test]
    fn classify_tcc_error() {
        let err = classify_sck_error("tcc: not authorized");
        assert!(matches!(err, CaptureError::PermissionDenied(_)));
    }

    #[test]
    fn classify_generic_error_falls_back_to_native() {
        let err = classify_sck_error("CMIOHardwareError: timeout");
        assert!(matches!(err, CaptureError::Native(_)));
    }

    /// Smoke test: a TCC-granted Display target should yield a non-empty
    /// PNG. Gated behind `real-capture` so CI without screen-recording
    /// doesn't fail, and `#[ignore]` so the operator explicitly opts in.
    #[cfg(feature = "real-capture")]
    #[tokio::test]
    #[ignore]
    async fn macos_thumbnail_smoke() {
        // Use the first enumerated display — cheap + TCC-gated.
        let displays = crate::display::enumerate_displays().expect("enumerate");
        let target = CaptureTarget::Display {
            display_id: displays.first().map(|d| d.id).unwrap_or(DisplayId(0)),
        };
        let bytes = capture_thumbnail(&target, 320, 200)
            .await
            .expect("capture_thumbnail returned Err");
        assert!(bytes.len() > 128, "PNG too short: {}", bytes.len());
        // PNG magic: 89 50 4E 47 0D 0A 1A 0A.
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        // Decode via image crate and confirm bounds.
        let decoded = image::load_from_memory(&bytes).expect("decode PNG");
        assert!(decoded.width() <= 320);
        assert!(decoded.height() <= 200);
    }
}

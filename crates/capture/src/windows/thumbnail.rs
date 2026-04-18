//! Plan 06-03 Task 2 — Windows single-frame WGC thumbnail capture.
//!
//! Implements the same contract as `macos::screenshot::capture_thumbnail`:
//! one short-lived WGC session that captures exactly ONE frame, stops
//! itself via `InternalCaptureControl::stop()`, downscales the BGRA
//! buffer, and encodes as PNG. The returned bytes are suitable for a
//! data URL / `createObjectURL` in the React recorder preview.
//!
//! Unlike the streaming backend, this session is created per call,
//! lives <1s, and is independent from the main recording session — a
//! concurrent full-speed recording on the same target won't be
//! disturbed because each `GraphicsCaptureItem` owns its own swap chain
//! (RESEARCH Pitfall 5 does NOT apply here; that was about crop APIs).
//!
//! For `DisplayRegion` targets we reuse `cpu_crop_bgra` + the same
//! display→physical-pixel scaling the main backend does — so the
//! thumbnail matches the recorded output byte-for-byte-ish (ignoring
//! the downscale).

#![cfg(target_os = "windows")]

use crate::error::CaptureError;
use crate::target::CaptureTarget;
use crate::windows::frame_from_wgc::{cpu_crop_bgra, PhysicalRectU32};
use parking_lot::Mutex;
use std::sync::Arc;

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

/// Flags threaded into the one-shot WGC handler via `Settings::new`.
struct ThumbFlags {
    slot: Arc<Mutex<Option<CapturedFrame>>>,
    crop_rect: Option<PhysicalRectU32>,
}

struct CapturedFrame {
    bgra: Vec<u8>,
    width_px: u32,
    height_px: u32,
}

#[derive(thiserror::Error, Debug)]
enum ThumbHandlerError {
    #[error("frame buffer acquisition failed: {0}")]
    Buffer(String),
}

struct ThumbHandler {
    slot: Arc<Mutex<Option<CapturedFrame>>>,
    crop_rect: Option<PhysicalRectU32>,
    done: bool,
}

impl GraphicsCaptureApiHandler for ThumbHandler {
    type Flags = ThumbFlags;
    type Error = ThumbHandlerError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            slot: ctx.flags.slot,
            crop_rect: ctx.flags.crop_rect,
            done: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WgcFrame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.done {
            // Spurious extra frame while teardown races — ignore.
            return Ok(());
        }
        let w = frame.width();
        let h = frame.height();
        let mut nopad_scratch: Vec<u8> = Vec::new();
        let buffer = frame
            .buffer()
            .map_err(|e| ThumbHandlerError::Buffer(format!("{e}")))?;
        let src = buffer.as_nopadding_buffer(&mut nopad_scratch);
        let stride = (w as usize) * 4;

        let (bgra, out_w, out_h) = if let Some(rect) = self.crop_rect {
            match cpu_crop_bgra(src, w, h, stride, rect) {
                Some(cropped) => (cropped, rect.w, rect.h),
                None => (src.to_vec(), w, h),
            }
        } else {
            // Copy now — the buffer reference is only valid inside this
            // callback. Cheaper than holding the D3D11 texture past return.
            (src.to_vec(), w, h)
        };

        {
            let mut slot = self.slot.lock();
            *slot = Some(CapturedFrame {
                bgra,
                width_px: out_w,
                height_px: out_h,
            });
        }
        self.done = true;
        capture_control.stop();
        Ok(())
    }
}

/// Capture a single thumbnail of `target`, downscaled to fit within
/// `max_width × max_height`, returned as PNG-encoded bytes.
pub async fn capture_thumbnail(
    target: &CaptureTarget,
    max_width: u32,
    max_height: u32,
) -> Result<Vec<u8>, CaptureError> {
    let target_owned = target.clone();

    // Pre-resolve the crop rect for DisplayRegion (shared helper w/ wgc_backend).
    let crop_rect = match &target_owned {
        CaptureTarget::DisplayRegion { display_id, rect } => Some(
            crate::windows::helpers::resolve_region_to_physical(display_id, rect)?,
        ),
        _ => None,
    };

    let slot: Arc<Mutex<Option<CapturedFrame>>> = Arc::new(Mutex::new(None));
    let slot_for_flags = slot.clone();
    let slot_for_poll = slot.clone();

    // `windows-capture` start APIs are synchronous and run the capture
    // pump on the current thread, so we wrap in spawn_blocking.
    tokio::task::spawn_blocking(move || -> Result<(), CaptureError> {
        let flags = ThumbFlags {
            slot: slot_for_flags,
            crop_rect,
        };
        let cursor = CursorCaptureSettings::WithCursor;
        let border = DrawBorderSettings::Default;
        let secondary = SecondaryWindowSettings::Default;
        let min_interval = MinimumUpdateIntervalSettings::Default;
        let dirty = DirtyRegionSettings::Default;
        let color_format = ColorFormat::Bgra8;

        // start_free_threaded so we can short-circuit via stop() from the
        // handler, but immediately join via .stop(). The handler itself
        // calls capture_control.stop() on frame 1, so the pump exits.
        let control = match &target_owned {
            CaptureTarget::Display { .. } | CaptureTarget::DisplayRegion { .. } => {
                let monitor = Monitor::primary()
                    .map_err(|e| CaptureError::Native(format!("Monitor::primary: {e}")))?;
                let settings = Settings::new(
                    monitor,
                    cursor,
                    border,
                    secondary,
                    min_interval,
                    dirty,
                    color_format,
                    flags,
                );
                ThumbHandler::start_free_threaded(settings)
                    .map_err(|e| CaptureError::Native(format!("WGC start: {e}")))?
            }
            CaptureTarget::Window { window_id } => {
                let hwnd = window_id.0 as isize as *mut std::ffi::c_void;
                let window = Window::from_raw_hwnd(hwnd);
                let settings = Settings::new(
                    window,
                    cursor,
                    border,
                    secondary,
                    min_interval,
                    dirty,
                    color_format,
                    flags,
                );
                ThumbHandler::start_free_threaded(settings)
                    .map_err(|e| CaptureError::Native(format!("WGC start: {e}")))?
            }
            CaptureTarget::WindowByPid { .. } => {
                // Thumbnails for PID-resolved targets need an async find;
                // callers of the thumbnail path use Display/Window/Region
                // variants. Refuse gracefully.
                return Err(CaptureError::UnsupportedTarget("WindowByPid (thumbnail)"));
            }
        };

        // Wait ≤ 1s for a frame. Poll the slot + control.stop() afterwards
        // to tear the session down cleanly.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            if slot_for_poll.lock().is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // stop() on the CaptureControl is idempotent — the handler may
        // have already posted WM_QUIT, but calling stop joins the thread.
        let _ = control.stop();
        Ok(())
    })
    .await
    .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))??;

    let captured = slot.lock().take().ok_or_else(|| {
        CaptureError::Timeout("thumbnail: no frame arrived within 1s".into())
    })?;

    // Downscale + PNG-encode. Stays on a blocking thread because both
    // ops are CPU-bound (~5-15ms for a 1080p BGRA + 320×200 PNG).
    tokio::task::spawn_blocking(move || {
        encode_bgra_to_png(&captured.bgra, captured.width_px, captured.height_px, max_width, max_height)
    })
    .await
    .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))?
}

/// BGRA → RGBA swap + resize + PNG encode. Pure CPU.
fn encode_bgra_to_png(
    bgra: &[u8],
    src_w: u32,
    src_h: u32,
    max_w: u32,
    max_h: u32,
) -> Result<Vec<u8>, CaptureError> {
    let expected = (src_w as usize) * (src_h as usize) * 4;
    if bgra.len() < expected {
        return Err(CaptureError::Native(format!(
            "BGRA buffer length {} < expected {} for {}×{}",
            bgra.len(),
            expected,
            src_w,
            src_h
        )));
    }
    // Swap BGRA → RGBA in-place on a copy.
    let mut rgba = Vec::with_capacity(expected);
    for px in bgra[..expected].chunks_exact(4) {
        rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }
    let img_buf: image::RgbaImage =
        image::ImageBuffer::from_raw(src_w, src_h, rgba).ok_or_else(|| {
            CaptureError::Native("image::ImageBuffer::from_raw returned None".into())
        })?;

    // Downscale — never upscale.
    let scale_x = if src_w > 0 { max_w as f64 / src_w as f64 } else { 1.0 };
    let scale_y = if src_h > 0 { max_h as f64 / src_h as f64 } else { 1.0 };
    let scale = scale_x.min(scale_y).min(1.0);
    let out_w = ((src_w as f64 * scale).max(1.0).round() as u32).max(1);
    let out_h = ((src_h as f64 * scale).max(1.0).round() as u32).max(1);
    let resized = if scale >= 0.999 {
        img_buf
    } else {
        image::imageops::resize(
            &img_buf,
            out_w,
            out_h,
            image::imageops::FilterType::CatmullRom,
        )
    };

    let mut out = Vec::with_capacity((out_w as usize) * (out_h as usize));
    let encoder = image::codecs::png::PngEncoder::new(&mut out);
    image::ImageEncoder::write_image(
        encoder,
        resized.as_raw(),
        resized.width(),
        resized.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| CaptureError::Native(format!("PNG encode: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_bgra_noop_downscale_produces_png() {
        // 2×2 BGRA, no downscale requested (max 10×10 > src). Red, green,
        // blue, white in BGRA.
        let bgra = vec![
            0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
        ];
        let png = encode_bgra_to_png(&bgra, 2, 2, 10, 10).expect("encode");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let decoded = image::load_from_memory(&png).expect("decode");
        assert_eq!(decoded.width(), 2);
        assert_eq!(decoded.height(), 2);
    }

    #[test]
    fn encode_bgra_downscale_bounded() {
        // 1920×1080 synthetic buffer downscaled to fit 320×200.
        let src_w = 1920u32;
        let src_h = 1080u32;
        let bgra = vec![128u8; (src_w * src_h * 4) as usize];
        let png = encode_bgra_to_png(&bgra, src_w, src_h, 320, 200).expect("encode");
        let decoded = image::load_from_memory(&png).expect("decode");
        // Aspect-ratio preserved: 1920/1080 = 16:9 → 320×180 (narrower edge wins).
        assert!(decoded.width() <= 320);
        assert!(decoded.height() <= 200);
        assert!(decoded.width() > 0 && decoded.height() > 0);
    }

    #[test]
    fn encode_bgra_rejects_short_buffer() {
        let bgra = vec![0u8; 10];
        let err = encode_bgra_to_png(&bgra, 100, 100, 320, 200).unwrap_err();
        assert!(matches!(err, CaptureError::Native(_)));
    }
}

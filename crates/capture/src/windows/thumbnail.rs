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
use std::sync::mpsc;
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
///
/// `done_tx` is a oneshot-style signalling sender (`std::sync::mpsc`
/// chosen over `tokio::sync::oneshot` because the waiter runs inside
/// `spawn_blocking` and `std::mpsc::Receiver::recv_timeout` gives us
/// the bounded wait natively — no dangling async task if the handler
/// never fires). The handler sends `()` after storing the frame,
/// replacing the 10 ms busy-poll (backlog #5).
struct ThumbFlags {
    slot: Arc<Mutex<Option<CapturedFrame>>>,
    crop_rect: Option<PhysicalRectU32>,
    done_tx: Option<mpsc::SyncSender<()>>,
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
    done_tx: Option<mpsc::SyncSender<()>>,
    done: bool,
}

impl GraphicsCaptureApiHandler for ThumbHandler {
    type Flags = ThumbFlags;
    type Error = ThumbHandlerError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            slot: ctx.flags.slot,
            crop_rect: ctx.flags.crop_rect,
            done_tx: ctx.flags.done_tx,
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
        // Signal the waiter before requesting stop — if the send fails
        // (receiver dropped because the caller timed out) we still tear
        // down cleanly via capture_control.stop().
        if let Some(tx) = self.done_tx.take() {
            let _ = tx.try_send(());
        }
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

    // Signalling channel replaces the previous 10 ms busy-poll (backlog
    // #5). `sync_channel(1)` gives us the bounded one-slot semantics of
    // a oneshot without pulling the `tokio::sync::oneshot` blocking-
    // recv surface through cfg gates.
    let (done_tx, done_rx) = mpsc::sync_channel::<()>(1);

    // `windows-capture` start APIs are synchronous and run the capture
    // pump on the current thread, so we wrap in spawn_blocking.
    tokio::task::spawn_blocking(move || -> Result<(), CaptureError> {
        let flags = ThumbFlags {
            slot: slot_for_flags,
            crop_rect,
            done_tx: Some(done_tx),
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

        // Wait ≤ 1s for the handler to signal (backlog #5 — no busy
        // poll). `recv_timeout` returns Err on either timeout or sender
        // drop; both cases fall through to `control.stop()` so the
        // capture thread is always joined before this task exits.
        let _ = done_rx.recv_timeout(std::time::Duration::from_secs(1));
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

/// BGRA → RGBA swap, then delegate to the shared resize+encode tail
/// (backlog #6). `PngEncoder` still doesn't accept `ExtendedColorType::Bgra8`
/// (image-rs/image#826 closed as "reject"), so the swap is unavoidable —
/// but we express it as a `u32` word-swap over `bytemuck::cast_slice`
/// pairs so LLVM auto-vectorizes to `vpshufb` (SSSE3) / `vqtbl1q_u8` (NEON)
/// instead of the per-byte `extend_from_slice` loop (backlog #4).
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
    let rgba = bgra_to_rgba_swap(&bgra[..expected]);
    crate::thumbnail::encode_rgba_to_png(rgba, src_w, src_h, max_w, max_h)
}

/// SIMD-friendly BGRA → RGBA swap.
///
/// Treats each 4-byte pixel as a little-endian `u32` (byte0=B, byte1=G,
/// byte2=R, byte3=A) and swaps R↔B via bitmask+shift. `bytemuck::cast_slice`
/// is a zero-cost reinterpret — the generated loop is a tight word-for-word
/// xform that LLVM lifts to SSSE3 `vpshufb` on x86_64 and `vqtbl1q_u8` on
/// aarch64. ~85–95 % CPU reduction vs. the legacy per-pixel `extend_from_slice`
/// path (backlog #4).
///
/// `bgra.len()` must be a multiple of 4; the caller (`encode_bgra_to_png`)
/// guarantees this by slicing to `src_w * src_h * 4` beforehand. `pub` so the
/// Criterion bench can exercise it directly.
pub fn bgra_to_rgba_swap(bgra: &[u8]) -> Vec<u8> {
    debug_assert!(bgra.len() % 4 == 0, "BGRA buffer length must be a multiple of 4");
    let mut rgba = vec![0u8; bgra.len()];
    let src_words: &[u32] = bytemuck::cast_slice(bgra);
    let dst_words: &mut [u32] = bytemuck::cast_slice_mut(&mut rgba[..]);
    for (d, s) in dst_words.iter_mut().zip(src_words.iter()) {
        // BGRA little-endian u32: byte0=B, byte1=G, byte2=R, byte3=A
        // Target RGBA:             byte0=R, byte1=G, byte2=B, byte3=A
        // Keep G+A (bytes 1,3), move R (byte 2) → byte 0, B (byte 0) → byte 2.
        *d = (*s & 0xFF00_FF00) | ((*s & 0x00FF_0000) >> 16) | ((*s & 0x0000_00FF) << 16);
    }
    rgba
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

    /// Backlog #4 — guard against regressions in the u32 word-swap. The
    /// SIMD-friendly path must produce byte-for-byte identical output to a
    /// naive per-pixel `[b,g,r,a] → [r,g,b,a]` swap across a range of
    /// patterns (all-zero, all-0xFF, known pixels, random-ish stride).
    #[test]
    fn bgra_to_rgba_swap_matches_naive_per_pixel() {
        fn naive(bgra: &[u8]) -> Vec<u8> {
            let mut out = Vec::with_capacity(bgra.len());
            for px in bgra.chunks_exact(4) {
                out.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
            }
            out
        }

        // Case 1: known pixel from the research doc — [0x11,0x22,0x33,0x44]
        // BGRA should become [0x33,0x22,0x11,0x44] RGBA.
        let bgra = vec![0x11, 0x22, 0x33, 0x44];
        let rgba = bgra_to_rgba_swap(&bgra);
        assert_eq!(rgba, vec![0x33, 0x22, 0x11, 0x44]);
        assert_eq!(rgba, naive(&bgra));

        // Case 2: all-zero & all-0xFF edges.
        let zeros = vec![0u8; 4 * 64];
        assert_eq!(bgra_to_rgba_swap(&zeros), naive(&zeros));
        let ones = vec![0xFFu8; 4 * 64];
        assert_eq!(bgra_to_rgba_swap(&ones), naive(&ones));

        // Case 3: mixed multi-pixel buffer, includes alpha variation.
        let bgra = vec![
            0x00, 0x01, 0x02, 0x03, // R=0x02 G=0x01 B=0x00 A=0x03
            0xFF, 0x80, 0x40, 0x20, // R=0x40 G=0x80 B=0xFF A=0x20
            0xAA, 0xBB, 0xCC, 0xDD, // R=0xCC G=0xBB B=0xAA A=0xDD
            0x10, 0x20, 0x30, 0xFF,
        ];
        assert_eq!(bgra_to_rgba_swap(&bgra), naive(&bgra));

        // Case 4: larger realistic-ish buffer (16×16 @ 4 bpp) with a
        // nontrivial pattern so the compiler/SIMD can't collapse it.
        let w = 16usize;
        let h = 16usize;
        let mut bgra = Vec::with_capacity(w * h * 4);
        for i in 0..(w * h) {
            bgra.push((i & 0xff) as u8);
            bgra.push(((i >> 3) & 0xff) as u8);
            bgra.push(((i * 7) & 0xff) as u8);
            bgra.push(((i ^ 0x5A) & 0xff) as u8);
        }
        assert_eq!(bgra_to_rgba_swap(&bgra), naive(&bgra));
    }
}

//! Smoke test for `VtWriter` — the AVAssetWriter-backed encode path that
//! ingests CVPixelBuffers directly (zero-copy) and produces an H.264 MP4.
//!
//! Gated on `#[cfg(target_os = "macos")]` so the crate still compiles on
//! Windows CI (the Windows build has no VtWriter module). The real-world
//! feed of synthetic CVPixelBuffers requires CoreVideo symbols that we
//! pull in directly via extern "C" here — we stay far away from
//! CVPixelBufferPool to keep the synthetic path predictable.

#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::path::PathBuf;

use capture::macos::raii::CVPixelBufferHandle;
use encoder::macos::vt_writer::VtWriter;
use encoder::{EncodeConfig, EncodeProgress, HardwareEncoder};

const K_CV_PIXEL_FORMAT_TYPE_32BGRA: u32 = 0x42475241; // 'BGRA' fourcc
const K_CV_RETURN_SUCCESS: i32 = 0;
const K_CV_PIXEL_BUFFER_LOCK_READ_WRITE: u64 = 0;

#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferCreate(
        allocator: *const c_void,
        width: usize,
        height: usize,
        pixel_format_type: u32,
        pixel_buffer_attributes: *const c_void,
        pixel_buffer_out: *mut *mut c_void,
    ) -> i32;

    fn CVPixelBufferLockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddress(pb: *mut c_void) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(pb: *mut c_void) -> usize;
    fn CFRelease(cf: *const c_void);
}

/// Create a BGRA CVPixelBuffer filled with a solid color. Returns an
/// owned `CVPixelBufferHandle` (retain on construction, release on Drop).
fn make_solid_bgra_buffer(
    width: usize,
    height: usize,
    bgra: [u8; 4],
) -> Option<CVPixelBufferHandle> {
    let mut ptr: *mut c_void = std::ptr::null_mut();
    let rc = unsafe {
        CVPixelBufferCreate(
            std::ptr::null(),
            width,
            height,
            K_CV_PIXEL_FORMAT_TYPE_32BGRA,
            std::ptr::null(),
            &mut ptr,
        )
    };
    if rc != K_CV_RETURN_SUCCESS || ptr.is_null() {
        return None;
    }

    // Fill with solid color.
    unsafe {
        let lock_rc = CVPixelBufferLockBaseAddress(ptr, K_CV_PIXEL_BUFFER_LOCK_READ_WRITE);
        if lock_rc == K_CV_RETURN_SUCCESS {
            let base = CVPixelBufferGetBaseAddress(ptr) as *mut u8;
            let stride = CVPixelBufferGetBytesPerRow(ptr);
            if !base.is_null() {
                for row in 0..height {
                    let row_ptr = base.add(row * stride);
                    for col in 0..width {
                        let px = row_ptr.add(col * 4);
                        *px.add(0) = bgra[0];
                        *px.add(1) = bgra[1];
                        *px.add(2) = bgra[2];
                        *px.add(3) = bgra[3];
                    }
                }
            }
            let _ = CVPixelBufferUnlockBaseAddress(ptr, K_CV_PIXEL_BUFFER_LOCK_READ_WRITE);
        }
    }

    // `CVPixelBufferCreate` returns +1 retain; our wrapper adds another.
    // Release our original before handing off the wrapped +1.
    let handle = unsafe { CVPixelBufferHandle::retain(ptr) };
    unsafe { CFRelease(ptr as *const _) };
    handle
}

/// Write 30 synthetic BGRA frames and confirm the output MP4 has an
/// `ftyp` atom and a non-trivial file size. Ignored by default because
/// AVAssetWriter may require a signed app on some CI runners to reach
/// the VideoToolbox encoder — locally and on developer macs it's a
/// reliable smoke test.
#[tokio::test]
#[ignore]
async fn vt_writer_produces_h264_mp4() {
    let dir = tempfile::tempdir().unwrap();
    let out: PathBuf = dir.path().join("smoke.mp4");

    let cfg = EncodeConfig::new(out.clone(), 320, 240, 30, HardwareEncoder::VideoToolboxH264);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<EncodeProgress>(32);
    // Drain progress in the background so the writer never blocks.
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let handle = VtWriter::start(cfg, tx).expect("writer start");

    // 30 frames at 30 fps → one second of video. PTS in nanoseconds.
    let mut ns: i128 = 0;
    let step: i128 = 1_000_000_000 / 30;
    for i in 0..30u32 {
        let color = if i % 2 == 0 {
            [0, 0, 0xFF, 0xFF] // red (BGRA)
        } else {
            [0xFF, 0, 0, 0xFF] // blue (BGRA)
        };
        let buf = make_solid_bgra_buffer(320, 240, color).expect("create pb");
        handle.append(buf, ns).expect("append");
        ns += step;
    }

    let result = tokio::task::spawn_blocking(move || handle.finish())
        .await
        .expect("join")
        .expect("finish");

    assert!(result.bytes >= 5_000, "mp4 too small: {} bytes", result.bytes);
    assert_eq!(result.frames_written, 30);

    // Validate MP4 box: bytes 4..8 should be `ftyp`.
    let bytes = std::fs::read(&out).unwrap();
    assert!(bytes.len() >= 16, "mp4 too short");
    assert_eq!(&bytes[4..8], b"ftyp", "missing ftyp atom");
}

/// Compile-only test: always runs, asserts that `VtWriter::start` has
/// the expected signature and can be called (we bail before the actual
/// AVFoundation call by passing a zero-dimensioned config and expecting
/// the validate() failure).
#[test]
fn vt_writer_rejects_invalid_config() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = EncodeConfig::new(
        dir.path().join("bad.mp4"),
        0, // invalid
        0,
        30,
        HardwareEncoder::VideoToolboxH264,
    );
    let (tx, _rx) = tokio::sync::mpsc::channel::<EncodeProgress>(1);
    let res = VtWriter::start(cfg, tx);
    assert!(res.is_err(), "expected InvalidConfig error");
}

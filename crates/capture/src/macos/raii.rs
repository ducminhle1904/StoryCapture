//! RAII wrappers around macOS native frame buffers.
//!
//! `CVPixelBufferHandle` holds a CFRetain on the pixel buffer; Drop
//! calls CFRelease so we never leak IOSurface backing memory. This is
//! the centerpiece of PITFALLS.md §8 (capture memory leaks) — every
//! native frame must travel through one of these wrappers.

use std::ffi::c_void;

/// Opaque pointer to a CoreVideo pixel buffer (`CVPixelBufferRef` is a
/// typedef for `*mut __CVBuffer`). We treat it as an opaque token here
/// to avoid pulling in `core-video-sys` for the public API surface.
pub struct CVPixelBufferHandle {
    ptr: *mut c_void,
}

// SAFETY: CVPixelBuffer is documented as thread-safe for reads; the
// retain/release operations are atomic. The producer side hands the
// frame off to the consumer via mpsc, after which only one task touches
// the handle at a time.
unsafe impl Send for CVPixelBufferHandle {}
unsafe impl Sync for CVPixelBufferHandle {}

extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFRelease(cf: *const c_void);
}

// CoreVideo FFI for the CPU-copy path — needed until an FFmpeg ingest
// route can consume the IOSurface directly without a copy.
#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferLockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferUnlockBaseAddress(pb: *mut c_void, flags: u64) -> i32;
    fn CVPixelBufferGetBaseAddress(pb: *mut c_void) -> *mut c_void;
    fn CVPixelBufferGetBytesPerRow(pb: *mut c_void) -> usize;
    fn CVPixelBufferGetWidth(pb: *mut c_void) -> usize;
    fn CVPixelBufferGetHeight(pb: *mut c_void) -> usize;
}

const K_CV_PIXEL_BUFFER_LOCK_READ_ONLY: u64 = 0x0000_0001;

impl CVPixelBufferHandle {
    /// Take ownership of an unretained pointer. `CFRetain` is called so
    /// the wrapper holds an independent retain count.
    ///
    /// # Safety
    /// `ptr` must be either null or a valid `CVPixelBufferRef` with at
    /// least one outstanding retain held by the caller for the duration
    /// of this call.
    pub unsafe fn retain(ptr: *mut c_void) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            unsafe { CFRetain(ptr as *const _) };
            Some(Self { ptr })
        }
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }

    /// Copy the CVPixelBuffer's BGRA pixel data into an owned Vec plus
    /// its per-row stride. Locks the base address read-only for the
    /// duration of the copy. Fails if the lock call returns a non-zero
    /// `CVReturn`.
    pub fn to_owned_bgra(&self) -> Result<(Vec<u8>, usize), i32> {
        unsafe {
            let rc = CVPixelBufferLockBaseAddress(self.ptr, K_CV_PIXEL_BUFFER_LOCK_READ_ONLY);
            if rc != 0 {
                return Err(rc);
            }
            let base = CVPixelBufferGetBaseAddress(self.ptr) as *const u8;
            let stride = CVPixelBufferGetBytesPerRow(self.ptr);
            let height = CVPixelBufferGetHeight(self.ptr);
            let len = stride * height;
            let mut out = Vec::with_capacity(len);
            if !base.is_null() && len > 0 {
                std::ptr::copy_nonoverlapping(base, out.as_mut_ptr(), len);
                out.set_len(len);
            }
            CVPixelBufferUnlockBaseAddress(self.ptr, K_CV_PIXEL_BUFFER_LOCK_READ_ONLY);
            Ok((out, stride))
        }
    }

    pub fn width(&self) -> usize {
        unsafe { CVPixelBufferGetWidth(self.ptr) }
    }

    pub fn height(&self) -> usize {
        unsafe { CVPixelBufferGetHeight(self.ptr) }
    }
}

impl Drop for CVPixelBufferHandle {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { CFRelease(self.ptr as *const _) };
        }
    }
}

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

impl CVPixelBufferHandle {
    /// Take ownership of an unretained pointer. `CFRetain` is called so
    /// the wrapper holds an independent retain count.
    ///
    /// SAFETY: `ptr` must be a valid `CVPixelBufferRef` (or null).
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
}

impl Drop for CVPixelBufferHandle {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { CFRelease(self.ptr as *const _) };
        }
    }
}

//! RAII wrappers for macOS frame buffers.
//!
//! `CVPixelBufferHandle` retains and releases `CVPixelBufferRef`s so
//! IOSurface-backed frames do not leak.

use std::ffi::c_void;

/// Opaque handle to a CoreVideo pixel buffer.
pub struct CVPixelBufferHandle {
    ptr: *mut c_void,
}

// SAFETY: read access is thread-safe and retain/release is atomic.
unsafe impl Send for CVPixelBufferHandle {}
unsafe impl Sync for CVPixelBufferHandle {}

extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFRelease(cf: *const c_void);
}

// CoreVideo FFI for the current CPU-copy path.
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
    /// Retain a raw `CVPixelBufferRef` and wrap it.
    ///
    /// # Safety
    /// `ptr` must be null or a valid `CVPixelBufferRef`.
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

    /// Copy BGRA bytes into an owned buffer and return its stride.
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

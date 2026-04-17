//! RAII wrapper for `ID3D11Texture2D` so the COM refcount is balanced
//! even on panic / early return paths. Mirrors `macos::raii::CVPixelBufferHandle`.

use std::ffi::c_void;

pub struct D3DTextureHandle {
    ptr: *mut c_void,
}

unsafe impl Send for D3DTextureHandle {}
unsafe impl Sync for D3DTextureHandle {}

impl D3DTextureHandle {
    /// Take ownership of an already-AddRef'd COM pointer. Caller must
    /// have already incremented the refcount (or be transferring its
    /// own); Drop calls `Release` once.
    ///
    /// # Safety
    ///
    /// `ptr` must be a valid `ID3D11Texture2D*` (or null) with a
    /// refcount the wrapper now owns.
    pub unsafe fn from_raw(ptr: *mut c_void) -> Option<Self> {
        if ptr.is_null() {
            None
        } else {
            Some(Self { ptr })
        }
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }
}

impl Drop for D3DTextureHandle {
    fn drop(&mut self) {
        if self.ptr.is_null() {
            return;
        }
        // SAFETY: We own one COM refcount; calling Release once balances
        // the AddRef the producer performed before handing us the ptr.
        // The first u64 of a COM vtable is the function pointer table;
        // Release is the third method (QI, AddRef, Release).
        unsafe {
            #[repr(C)]
            struct VtblHeader {
                _query_interface: *const c_void,
                _add_ref: *const c_void,
                release: unsafe extern "system" fn(*mut c_void) -> u32,
            }
            let obj = self.ptr as *mut *const VtblHeader;
            let vtbl = *obj;
            ((*vtbl).release)(self.ptr);
        }
    }
}

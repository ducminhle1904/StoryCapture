//! BGRA scratch buffer pool for the Windows.Graphics.Capture path
//! (backlog item #2 step A2).
//!
//! At 1080p30, each frame copies ~8 MB of BGRA bytes out of the D3D11
//! staging texture. Without a pool this allocation happens on every
//! frame; at steady state the allocator churns ~240 MB/s (step A1
//! eliminated another ~240 MB/s on the encoder clone).
//!
//! `FramePool` holds a small `Vec<Vec<u8>>` (capped at `MAX_POOLED`)
//! guarded by a `parking_lot::Mutex`. Producers acquire a buffer via
//! `acquire_or_new`, fill it in `to_frame`, and hand out a `PooledBuf`
//! that returns the allocation to the pool when dropped by the encoder.
//!
//! ## Thread model
//!
//! - The producer (`WgcHandler::on_frame_arrived`) and the consumer
//!   (`EncodePipeline` frame pump) are on different threads. The pool
//!   is accessed from both, hence the `Arc<Mutex<_>>`.
//! - `Weak` is embedded in each `PooledBuf`: if `WgcBackend` drops
//!   (capture stops) before the encoder finishes draining, the Weak
//!   upgrade fails and the buffer is simply freed — no UAF, no leak.
//! - Pool is capped: if the encoder stalls briefly and frames back up,
//!   the excess buffers are freed on drop instead of growing unbounded.
//!
//! ## Sizing
//!
//! `MAX_POOLED = 4` — the capture → encoder mpsc queue is 64 frames
//! deep, but under healthy conditions only 1–3 frames are in flight
//! at once. Extra pooled buffers are wasted RSS.

#![cfg(target_os = "windows")]

use parking_lot::Mutex;
use std::mem::ManuallyDrop;
use std::ops::Deref;
use std::sync::{Arc, Weak};

/// Maximum number of buffers retained in the pool. See module docs.
pub const MAX_POOLED: usize = 4;

/// Shared buffer pool. Cheap to clone (`Arc`).
pub type FramePool = Arc<Mutex<Vec<Vec<u8>>>>;

/// Allocate a new empty pool.
pub fn new_pool() -> FramePool {
    Arc::new(Mutex::new(Vec::with_capacity(MAX_POOLED)))
}

/// Acquire a buffer with at least `min_cap` bytes of capacity. If the
/// pool has a suitable buffer the allocation is reused; otherwise a
/// fresh `Vec::with_capacity` is returned. The returned `Vec` has
/// `len() == 0` — the caller is responsible for filling it (via
/// `extend_from_slice`, `resize`, etc.).
pub fn acquire_or_new(pool: &FramePool, min_cap: usize) -> Vec<u8> {
    let mut g = pool.lock();
    // Prefer the most recently returned buffer (LIFO) for cache warmth.
    while let Some(mut buf) = g.pop() {
        buf.clear();
        if buf.capacity() >= min_cap {
            return buf;
        }
        // Capacity too small (e.g. frame size grew) — discard and try
        // the next pooled buffer. The old allocation is freed here.
    }
    Vec::with_capacity(min_cap)
}

/// A BGRA buffer borrowed from a `FramePool`. Derefs to `&[u8]`. On
/// drop, the underlying `Vec<u8>` is returned to the pool (if the pool
/// is still alive and below `MAX_POOLED`); otherwise the allocation is
/// freed.
pub struct PooledBuf {
    /// The owned buffer. `ManuallyDrop` so `Drop::drop` can `take` it
    /// and decide whether to return it to the pool or free it.
    bytes: ManuallyDrop<Vec<u8>>,
    /// Weak ref to the pool. `Weak` so that if `WgcBackend` tears down
    /// before the encoder finishes draining pending frames, the upgrade
    /// fails and the buffer is freed cleanly — no dangling Arc keeping
    /// the pool alive past backend stop.
    pool: Weak<Mutex<Vec<Vec<u8>>>>,
}

impl PooledBuf {
    /// Wrap an already-filled `Vec<u8>` so it will return to `pool` on
    /// drop. The caller has populated the vec with exactly the bytes
    /// to emit.
    pub fn new(bytes: Vec<u8>, pool: &FramePool) -> Self {
        Self {
            bytes: ManuallyDrop::new(bytes),
            pool: Arc::downgrade(pool),
        }
    }

    /// Byte length of the pooled buffer.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// True if the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Borrow the bytes.
    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }
}

impl Deref for PooledBuf {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}

impl Drop for PooledBuf {
    fn drop(&mut self) {
        // SAFETY: `bytes` is in `ManuallyDrop` and we are in `drop`; no
        // code below will access `self.bytes` again.
        let buf = unsafe { ManuallyDrop::take(&mut self.bytes) };
        if let Some(pool) = self.pool.upgrade() {
            let mut g = pool.lock();
            if g.len() < MAX_POOLED {
                // `buf` will be cleared on next acquire; keep capacity.
                g.push(buf);
                return;
            }
        }
        // Pool gone or full — let `buf` drop naturally (frees memory).
        drop(buf);
    }
}

impl std::fmt::Debug for PooledBuf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "PooledBuf({} bytes, cap={})",
            self.bytes.len(),
            self.bytes.capacity()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_reuses_buffer_on_drop() {
        let pool = new_pool();
        let buf = acquire_or_new(&pool, 1024);
        let ptr = buf.as_ptr();
        let cap = buf.capacity();
        assert!(cap >= 1024);
        let pooled = PooledBuf::new(buf, &pool);
        drop(pooled);
        // The buffer should now be back in the pool and re-acquired at
        // the same allocation.
        let buf2 = acquire_or_new(&pool, 1024);
        assert_eq!(buf2.as_ptr(), ptr, "pool should return same allocation");
        assert_eq!(buf2.capacity(), cap);
    }

    #[test]
    fn pool_caps_at_max_pooled() {
        let pool = new_pool();
        // Return MAX_POOLED + 2 buffers; the last 2 must be freed.
        for _ in 0..(MAX_POOLED + 2) {
            let buf = Vec::<u8>::with_capacity(64);
            let pooled = PooledBuf::new(buf, &pool);
            drop(pooled);
        }
        let g = pool.lock();
        assert_eq!(g.len(), MAX_POOLED);
    }

    #[test]
    fn weak_drop_after_pool_gone_is_safe() {
        let pool = new_pool();
        let pooled = PooledBuf::new(vec![0u8; 16], &pool);
        // Drop the pool first — the Weak inside `pooled` will fail to
        // upgrade; the buffer should just free without panic.
        drop(pool);
        drop(pooled);
    }

    #[test]
    fn acquire_growing_size_discards_small_buffers() {
        let pool = new_pool();
        // Seed pool with a small buffer.
        {
            let small = Vec::<u8>::with_capacity(128);
            let p = PooledBuf::new(small, &pool);
            drop(p);
        }
        // Request a bigger buffer; the small one should be discarded
        // and a new allocation returned.
        let big = acquire_or_new(&pool, 1_000_000);
        assert!(big.capacity() >= 1_000_000);
        // Pool should now be empty.
        assert_eq!(pool.lock().len(), 0);
    }

    #[test]
    fn pooled_buf_deref_exposes_bytes() {
        let pool = new_pool();
        let buf = vec![1u8, 2, 3, 4];
        let p = PooledBuf::new(buf, &pool);
        let slice: &[u8] = &p;
        assert_eq!(slice, &[1, 2, 3, 4]);
        assert_eq!(p.len(), 4);
        assert!(!p.is_empty());
    }
}

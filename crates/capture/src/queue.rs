//! Byte-bounded frame queue (D-19, CAP-05).
//!
//! Critical invariant: cap is in **bytes**, not frames. 4K60 BGRA is
//! ~25 MiB per frame; a naive 32-frame queue is 800 MiB. We bound by
//! bytes so the cap stays meaningful regardless of resolution.
//!
//! Drop policy: if pushing the new frame would exceed `cap_bytes`, the
//! NEW frame is dropped and `dropped_frames` is incremented. We choose
//! drop-newest (rather than drop-oldest) because PTS continuity matters
//! more than the most recent sample for video — losing the latest frame
//! produces a brief stall, while losing older frames creates timeline
//! holes the encoder has to interpolate.

use crate::frame::Frame;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

/// Counters maintained over the queue's lifetime. Exposed via
/// `ByteBoundedQueue::stats()` for the soak test and the recorder UI.
#[derive(Debug, Clone, Copy, Default)]
pub struct QueueStats {
    pub total_pushed: u64,
    pub total_popped: u64,
    pub dropped_frames: u64,
    pub max_bytes_seen: usize,
}

/// Reason a `try_push` returned `Err(DroppedFrame)`.
#[derive(Debug)]
pub struct DroppedFrame {
    pub size_bytes: usize,
    pub current_bytes: usize,
    pub cap_bytes: usize,
}

/// Byte-bounded MPSC-style frame channel. One producer (the capture
/// backend's output handler) and one consumer (the pipeline forwarder).
pub struct ByteBoundedQueue {
    cap_bytes: usize,
    current_bytes: AtomicUsize,
    inner: Mutex<VecDeque<Frame>>,
    notify: Notify,
    stats: Mutex<QueueStats>,
    closed: parking_lot::RwLock<bool>,
}

impl ByteBoundedQueue {
    /// Default cap per D-19: 256 MiB.
    pub const DEFAULT_CAP_BYTES: usize = 256 * 1024 * 1024;

    pub fn new(cap_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            cap_bytes,
            current_bytes: AtomicUsize::new(0),
            inner: Mutex::new(VecDeque::new()),
            notify: Notify::new(),
            stats: Mutex::new(QueueStats::default()),
            closed: parking_lot::RwLock::new(false),
        })
    }

    pub fn cap_bytes(&self) -> usize {
        self.cap_bytes
    }

    /// Try to push a frame. Returns `Err(DroppedFrame)` if the cap would
    /// be exceeded (the frame is dropped and `dropped_frames` is bumped).
    pub fn try_push(&self, frame: Frame) -> Result<(), DroppedFrame> {
        let size = frame.byte_size();
        let current = self.current_bytes.load(Ordering::Acquire);
        if current.saturating_add(size) > self.cap_bytes {
            let mut stats = self.stats.lock();
            stats.dropped_frames += 1;
            tracing::warn!(
                size_bytes = size,
                current_bytes = current,
                cap_bytes = self.cap_bytes,
                dropped_total = stats.dropped_frames,
                "frame dropped: byte-bounded queue full"
            );
            return Err(DroppedFrame {
                size_bytes: size,
                current_bytes: current,
                cap_bytes: self.cap_bytes,
            });
        }
        // Reserve bytes BEFORE locking, so we never double-account if a
        // concurrent consumer pops between our load and our push.
        let after = self.current_bytes.fetch_add(size, Ordering::AcqRel) + size;
        {
            let mut q = self.inner.lock();
            q.push_back(frame);
            let mut stats = self.stats.lock();
            stats.total_pushed += 1;
            if after > stats.max_bytes_seen {
                stats.max_bytes_seen = after;
            }
        }
        self.notify.notify_one();
        Ok(())
    }

    /// Pop one frame. Awaits if the queue is empty. Returns `None` when
    /// the queue is closed and drained.
    pub async fn recv(&self) -> Option<Frame> {
        loop {
            // Fast path: take immediately if available.
            {
                let mut q = self.inner.lock();
                if let Some(frame) = q.pop_front() {
                    let size = frame.byte_size();
                    self.current_bytes.fetch_sub(size, Ordering::AcqRel);
                    self.stats.lock().total_popped += 1;
                    return Some(frame);
                }
                if *self.closed.read() {
                    return None;
                }
            }
            // Slow path: register for notification, then re-check (avoids
            // missed-wakeup races against try_push).
            let waiter = self.notify.notified();
            tokio::pin!(waiter);
            // Recheck before awaiting in case a push raced in.
            {
                let mut q = self.inner.lock();
                if let Some(frame) = q.pop_front() {
                    let size = frame.byte_size();
                    self.current_bytes.fetch_sub(size, Ordering::AcqRel);
                    self.stats.lock().total_popped += 1;
                    return Some(frame);
                }
                if *self.closed.read() {
                    return None;
                }
            }
            waiter.as_mut().await;
        }
    }

    /// Synchronous, non-blocking pop. Used by tests.
    pub fn try_pop(&self) -> Option<Frame> {
        let mut q = self.inner.lock();
        if let Some(frame) = q.pop_front() {
            let size = frame.byte_size();
            self.current_bytes.fetch_sub(size, Ordering::AcqRel);
            self.stats.lock().total_popped += 1;
            Some(frame)
        } else {
            None
        }
    }

    pub fn current_bytes(&self) -> usize {
        self.current_bytes.load(Ordering::Acquire)
    }

    pub fn stats(&self) -> QueueStats {
        *self.stats.lock()
    }

    /// Close the queue: subsequent pushes still account but `recv()` will
    /// return `None` once the deque is drained.
    pub fn close(&self) {
        *self.closed.write() = true;
        self.notify.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{Frame, FrameData, PixelFormat, Pts};

    fn owned_frame(seq: u64, size_bytes: usize) -> Frame {
        Frame {
            pts: Pts::synthetic(seq as i128 * 16_666_666),
            width_px: 1,
            height_px: 1,
            format: PixelFormat::Bgra,
            data: FrameData::Owned(vec![0u8; size_bytes], size_bytes),
            sequence: seq,
        }
    }

    #[test]
    fn bytes_accounting_drops_when_cap_exceeded() {
        let q = ByteBoundedQueue::new(1000);
        q.try_push(owned_frame(0, 300)).unwrap();
        q.try_push(owned_frame(1, 300)).unwrap();
        q.try_push(owned_frame(2, 300)).unwrap();
        // 4th frame would push to 1200 > 1000; must drop, leaving 900.
        let err = q.try_push(owned_frame(3, 300)).unwrap_err();
        assert_eq!(err.cap_bytes, 1000);
        assert_eq!(q.current_bytes(), 900);
        assert_eq!(q.stats().dropped_frames, 1);
        assert_eq!(q.stats().total_pushed, 3);
    }

    #[test]
    fn fifo_order_preserved() {
        let q = ByteBoundedQueue::new(10_000);
        for seq in 0..5 {
            q.try_push(owned_frame(seq, 100)).unwrap();
        }
        for seq in 0..5 {
            let f = q.try_pop().expect("frame");
            assert_eq!(f.sequence, seq);
        }
    }
}

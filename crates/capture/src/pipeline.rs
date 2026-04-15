//! Pipeline tying a `CaptureBackend` to a `ByteBoundedQueue` and a
//! consumer mpsc sender. Owns the forwarder task. Stats accumulate across
//! the run and are returned by `stop()`.

use crate::backend::{CaptureBackend, CaptureConfig, CaptureStats};
use crate::error::CaptureError;
use crate::frame::Frame;
use crate::queue::ByteBoundedQueue;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub struct CapturePipeline {
    backend: Box<dyn CaptureBackend>,
    queue: Arc<ByteBoundedQueue>,
    forwarder: Option<JoinHandle<()>>,
    consumer: Option<JoinHandle<()>>,
}

impl CapturePipeline {
    /// Build a new pipeline. `out` is the consumer-facing channel — the
    /// encoder (Plan 01-08) hooks up to its receiver.
    pub fn new(
        backend: Box<dyn CaptureBackend>,
        queue: Arc<ByteBoundedQueue>,
    ) -> Self {
        Self {
            backend,
            queue,
            forwarder: None,
            consumer: None,
        }
    }

    pub fn queue(&self) -> &Arc<ByteBoundedQueue> {
        &self.queue
    }

    /// Start capture + forwarding. Backends emit frames into an internal
    /// mpsc channel; we drain it, push into the byte-bounded queue, and
    /// forward to `out`.
    pub async fn start(
        &mut self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError> {
        let (tx, mut rx) = mpsc::channel::<Frame>(64);
        self.backend.start(cfg, tx).await?;

        let queue = self.queue.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                if let Err(dropped) = queue.try_push(frame) {
                    // Already logged by the queue; just keep going.
                    let _ = dropped;
                }
            }
            // Backend hung up — close the queue so any consumer
            // awaiting `recv()` sees EOF.
            queue.close();
        });
        self.forwarder = Some(forwarder);

        let queue = self.queue.clone();
        let consumer = tokio::spawn(async move {
            while let Some(frame) = queue.recv().await {
                if out.send(frame).await.is_err() {
                    break;
                }
            }
        });
        self.consumer = Some(consumer);

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        let stats = self.backend.stop().await?;
        // Forwarder will exit on its own when the backend's tx side drops.
        if let Some(h) = self.forwarder.take() {
            let _ = h.await;
        }
        if let Some(h) = self.consumer.take() {
            let _ = h.await;
        }
        Ok(stats)
    }
}

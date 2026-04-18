//! Pipeline tying a `CaptureBackend` to a `ByteBoundedQueue` and a
//! consumer mpsc sender. Owns the forwarder task. Stats accumulate across
//! the run and are returned by `stop()`.

use crate::backend::{CaptureBackend, CaptureConfig, CaptureStats};
use crate::error::CaptureError;
use crate::frame::Frame;
use crate::queue::ByteBoundedQueue;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

/// Boxed callback for per-session drop telemetry. Invoked with
/// `(total, delta)` each time the queue reports newly dropped frames.
/// The callback MUST be cheap and non-blocking (e.g. a best-effort channel
/// send) — capture throughput is never gated on its completion.
pub type DropEventCallback = Box<dyn Fn(u64, u64) + Send + Sync>;

pub struct CapturePipeline {
    backend: Box<dyn CaptureBackend>,
    queue: Arc<ByteBoundedQueue>,
    forwarder: Option<JoinHandle<()>>,
    consumer: Option<JoinHandle<()>>,
    telemetry: Option<JoinHandle<()>>,
    telemetry_cancel: Option<oneshot::Sender<()>>,
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
            telemetry: None,
            telemetry_cancel: None,
        }
    }

    pub fn queue(&self) -> &Arc<ByteBoundedQueue> {
        &self.queue
    }

    /// Start capture + forwarding. Backends emit frames into an internal
    /// mpsc channel; we drain it, push into the byte-bounded queue, and
    /// forward to `out`.
    ///
    /// If `on_drop` is `Some`, a lightweight telemetry task polls the
    /// queue's `dropped_frames` counter every 500ms and invokes the
    /// callback with `(total, delta)` whenever new drops are observed.
    /// Pass `None` when the consumer does not need drop telemetry.
    pub async fn start(
        &mut self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
        on_drop: Option<DropEventCallback>,
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

        // Optional drop-telemetry task. 500ms cadence is a best-effort
        // compromise between UI responsiveness and overhead; the task is
        // stopped via a oneshot cancel fired in `stop()`.
        if let Some(cb) = on_drop {
            let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
            let queue = self.queue.clone();
            let telemetry = tokio::spawn(async move {
                let mut last_total: u64 = 0;
                let mut ticker = tokio::time::interval(Duration::from_millis(500));
                // Skip the first immediate tick (interval fires once instantly).
                ticker.tick().await;
                loop {
                    tokio::select! {
                        _ = &mut cancel_rx => break,
                        _ = ticker.tick() => {
                            let total = queue.stats().dropped_frames;
                            if total > last_total {
                                let delta = total - last_total;
                                last_total = total;
                                // Best-effort: never block or panic on
                                // telemetry callback failures.
                                cb(total, delta);
                            }
                        }
                    }
                }
            });
            self.telemetry = Some(telemetry);
            self.telemetry_cancel = Some(cancel_tx);
        }

        Ok(())
    }

    pub async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        let stats = self.backend.stop().await?;
        // Signal telemetry task to exit (if running); await it but drop
        // any error — telemetry is best-effort.
        if let Some(cancel) = self.telemetry_cancel.take() {
            let _ = cancel.send(());
        }
        if let Some(h) = self.telemetry.take() {
            let _ = h.await;
        }
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

//! Pipeline tying a `CaptureBackend` to a `ByteBoundedQueue` and a
//! consumer mpsc sender. Owns the forwarder task. Stats accumulate across
//! the run and are returned by `stop()`.

use crate::backend::{CaptureBackend, CaptureConfig, CaptureStats};
use crate::error::CaptureError;
use crate::events::CaptureEvent;
use crate::frame::Frame;
use crate::orchestrator::{orchestrate_start, FallbackCounter, OrchestratedStart};
use crate::queue::ByteBoundedQueue;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

/// Re-exported for historical call-site names. The callback MUST be cheap
/// and non-blocking (e.g. a best-effort channel send) — capture throughput
/// is never gated on its completion.
pub use util::FrameDropCallback as DropEventCallback;

/// Small burst buffer between native capture callbacks and the byte-bounded
/// queue. Keeping this intentionally low prevents multiple large BGRA frames
/// from accumulating outside the queue's byte accounting.
const BACKEND_BURST_CHANNEL_CAPACITY: usize = 4;

pub struct CapturePipeline {
    backend: Option<Box<dyn CaptureBackend>>,
    queue: Arc<ByteBoundedQueue>,
    forwarder: Option<JoinHandle<()>>,
    consumer: Option<JoinHandle<()>>,
    telemetry: Option<JoinHandle<()>>,
    telemetry_cancel: Option<oneshot::Sender<()>>,
}

impl CapturePipeline {
    /// Build a new pipeline. `out` is the consumer-facing channel — the
    /// encoder hooks up to its receiver.
    pub fn new(backend: Box<dyn CaptureBackend>, queue: Arc<ByteBoundedQueue>) -> Self {
        Self {
            backend: Some(backend),
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

    fn backend_mut(&mut self) -> Result<&mut Box<dyn CaptureBackend>, CaptureError> {
        self.backend
            .as_mut()
            .ok_or_else(|| CaptureError::Backend("capture pipeline backend missing".into()))
    }

    fn attach_forwarders(
        &mut self,
        mut rx: mpsc::Receiver<Frame>,
        out: mpsc::Sender<Frame>,
        on_drop: Option<DropEventCallback>,
    ) {
        // Cancel any prior telemetry task before wiring a new run.
        if let Some(cancel) = self.telemetry_cancel.take() {
            let _ = cancel.send(());
        }

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
    }

    /// Start capture + forwarding. Backends emit frames into a small internal
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
        let (tx, rx) = mpsc::channel::<Frame>(BACKEND_BURST_CHANNEL_CAPACITY);
        self.backend_mut()?.start(cfg, tx).await?;
        self.attach_forwarders(rx, out, on_drop);
        Ok(())
    }

    /// Start capture through the native fallback orchestrator and then attach
    /// the same queue/forwarder plumbing used by the direct `start()` path.
    pub async fn start_orchestrated(
        &mut self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
        event_sink: Option<mpsc::UnboundedSender<CaptureEvent>>,
        counter: FallbackCounter,
        on_drop: Option<DropEventCallback>,
    ) -> Result<OrchestratedStart, CaptureError> {
        let (tx, rx) = mpsc::channel::<Frame>(BACKEND_BURST_CHANNEL_CAPACITY);
        let preferred = self
            .backend
            .take()
            .ok_or_else(|| CaptureError::Backend("capture pipeline backend missing".into()))?;
        let (backend, outcome) = orchestrate_start(preferred, cfg, tx, event_sink, counter).await?;
        self.backend = Some(backend);
        self.attach_forwarders(rx, out, on_drop);
        Ok(outcome)
    }

    pub async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        let stats = self.backend_mut()?.stop().await?;
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

    pub async fn pause(&mut self) -> Result<(), CaptureError> {
        self.backend_mut()?.pause().await
    }

    pub async fn resume(&mut self) -> Result<(), CaptureError> {
        self.backend_mut()?.resume().await
    }
}

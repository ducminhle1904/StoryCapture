//! `CaptureBackend` — the unified backend trait. SCK / WGC / xcap each
//! implement this. The pipeline drives a `Box<dyn CaptureBackend>` and
//! never knows which platform it's on.

use crate::display::{DisplayId, DisplayInfo};
use crate::error::CaptureError;
use crate::frame::{Frame, PixelFormat};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackendKind {
    /// Native SCK / WGC zero-copy path.
    Native,
    /// xcap polling fallback.
    Xcap,
}

#[derive(Debug, Clone)]
pub struct CaptureConfig {
    pub display_id: DisplayId,
    pub include_cursor: bool,
    /// Advisory FPS hint. SCK + WGC are variable-frame-rate; xcap
    /// fallback honors this exactly via a tokio interval.
    pub fps_target: u32,
    pub pixel_format: PixelFormat,
    /// Cap for the byte-bounded queue (D-19). Default 256 MiB.
    pub queue_cap_bytes: usize,
}

impl CaptureConfig {
    pub fn new(display_id: DisplayId) -> Self {
        Self {
            display_id,
            include_cursor: true,
            fps_target: 60,
            pixel_format: PixelFormat::Bgra,
            queue_cap_bytes: crate::queue::ByteBoundedQueue::DEFAULT_CAP_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct CaptureStats {
    pub frames_delivered: u64,
    pub frames_dropped: u64,
    pub bytes_peak: usize,
    pub duration_ms: u64,
}

/// Backend trait. `start` hands frames out via the supplied mpsc sender
/// (the pipeline owns the receiver and forwards into the byte-bounded
/// queue). `stop` is allowed to block briefly to drain in-flight frames
/// and finalize stats.
#[async_trait]
pub trait CaptureBackend: Send + Sync {
    fn kind(&self) -> BackendKind;

    async fn start(
        &mut self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError>;

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError>;

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError>;
}

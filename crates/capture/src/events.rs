//! Capture lifecycle events forwarded to the host and UI.

use crate::backend::CaptureStats;
use crate::display::DisplayInfo;
use crate::frame::Pts;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CaptureEvent {
    Started {
        display: DisplayInfo,
    },
    FrameDelivered {
        sequence: u64,
        pts: Pts,
        bytes: usize,
    },
    FrameDropped {
        sequence: u64,
        reason: String,
    },
    PermissionDenied {
        platform_hint: String,
    },
    /// Backend failed mid-stream; stop and finalize partial output.
    BackendFailed {
        reason: String,
    },
    /// Window capture failed to start and fell back to full-display capture.
    WindowCaptureFellBack {
        reason: String,
    },
    /// Repeated fallback in one session; UI should offer escalation actions.
    WindowCaptureDegraded {
        reason: String,
    },
    Stopped {
        stats: CaptureStats,
    },
}

//! Capture lifecycle events. The Tauri host re-serializes these through a
//! `Channel<CaptureEvent>` (Plan 01-09 wires the UI subscriber).

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
    /// SCK delegate reported an error mid-stream (window closed, TCC
    /// revoked, hardware fault). The pipeline will stop and finalize the
    /// partial MP4 (D-03). Plan 05-01 Task 2 wires this from the SCK
    /// StreamCallbacks::on_stop/on_error hooks.
    BackendFailed {
        reason: String,
    },
    /// SCK window-target capture failed to start; we silently fell back
    /// to xcap full-display (D-07). Plan 05-01 Task 3 emits this from
    /// the orchestrator.
    WindowCaptureFellBack {
        reason: String,
    },
    /// Second consecutive fallback in the same session (D-08). UI shows
    /// the modal with "Open System Settings" / "Use full screen" buttons.
    WindowCaptureDegraded {
        reason: String,
    },
    Stopped {
        stats: CaptureStats,
    },
}

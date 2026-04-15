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
    Stopped {
        stats: CaptureStats,
    },
}

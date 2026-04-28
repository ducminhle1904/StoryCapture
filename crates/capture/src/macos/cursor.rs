//! macOS cursor sampling for trajectory recording (Phase 19-02).
//!
//! Uses `core-graphics::event::CGEvent::location()` which returns the
//! cursor position in screen coordinates with the **top-left** origin
//! convention already applied (CG screen coordinate space, not the
//! NSEvent flipped one). No flip needed.
//!
//! `core-graphics` is already a workspace dep (see capture/Cargo.toml),
//! so this adds zero new dependencies.

use core_graphics::event::CGEvent;
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

/// Sample the current cursor position in screen px (top-left origin).
/// Returns `None` if the OS API is unavailable (e.g. headless CI).
pub fn sample_cursor() -> Option<(f32, f32)> {
    // CGEventSource is cheap to create per-call; we deliberately don't
    // cache it across the FFI boundary because it is not Send/Sync.
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let p = event.location();
    Some((p.x as f32, p.y as f32))
}

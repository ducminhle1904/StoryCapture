//! macOS cursor sampling for trajectory recording (Phase 19-02).
//!
//! Uses `core-graphics::event::CGEvent::location()` which returns the
//! cursor position in screen coordinates with the **top-left** origin
//! convention already applied (CG screen coordinate space, not the
//! NSEvent flipped one). No flip needed.
//!
//! `core-graphics` is already a workspace dep (see capture/Cargo.toml),
//! so this adds zero new dependencies.

use core_foundation::runloop::{kCFRunLoopCommonModes, kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{
    CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::sync::atomic::AtomicU64;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Background macOS event tap handle.
pub struct ClickTap {
    stop_tx: mpsc::Sender<()>,
    run_loop: Option<CFRunLoop>,
    join: Option<JoinHandle<()>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClickTapError {
    #[error("failed to create CGEventTap; Accessibility/TCC permission may be denied")]
    CreateTap,
    #[error("failed to create CGEventTap run loop source")]
    RunLoopSource,
    #[error("CGEventTap worker did not report readiness")]
    ReadyTimeout,
    #[error("failed to spawn CGEventTap worker: {0}")]
    Spawn(std::io::Error),
}

/// Install a listen-only CGEventTap for left/right mouse-down events.
///
/// Failure is expected on first-run macOS hosts without Accessibility
/// permission. Callers should log and continue recording cursor positions.
pub fn install_click_tap(latest_click_at: Arc<AtomicU64>) -> Result<ClickTap, ClickTapError> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<CFRunLoop, ClickTapError>>(1);
    let join = thread::Builder::new()
        .name("trajectory-click-tap".into())
        .spawn(move || {
            let run_loop = CFRunLoop::get_current();
            let tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::LeftMouseDown, CGEventType::RightMouseDown],
                move |_proxy, event_type, _event| {
                    if matches!(
                        event_type,
                        CGEventType::LeftMouseDown | CGEventType::RightMouseDown
                    ) {
                        crate::trajectory::record_click_now(&latest_click_at);
                    }
                    None
                },
            ) {
                Ok(tap) => tap,
                Err(()) => {
                    let _ = ready_tx.send(Err(ClickTapError::CreateTap));
                    return;
                }
            };

            let loop_source = match tap.mach_port.create_runloop_source(0) {
                Ok(source) => source,
                Err(()) => {
                    let _ = ready_tx.send(Err(ClickTapError::RunLoopSource));
                    return;
                }
            };

            // SAFETY: core-foundation exposes the process-global run loop
            // mode constants as extern statics.
            run_loop.add_source(&loop_source, unsafe { kCFRunLoopCommonModes });
            tap.enable();
            let _ = ready_tx.send(Ok(run_loop.clone()));

            loop {
                match stop_rx.try_recv() {
                    Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                // SAFETY: core-foundation exposes the process-global run loop
                // mode constants as extern statics.
                let _ = CFRunLoop::run_in_mode(
                    unsafe { kCFRunLoopDefaultMode },
                    Duration::from_millis(100),
                    true,
                );
            }
        })
        .map_err(ClickTapError::Spawn)?;

    let run_loop = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(run_loop)) => Some(run_loop),
        Ok(Err(error)) => {
            let _ = join.join();
            return Err(error);
        }
        Err(_) => {
            let _ = stop_tx.send(());
            let _ = join.join();
            return Err(ClickTapError::ReadyTimeout);
        }
    };

    Ok(ClickTap {
        stop_tx,
        run_loop,
        join: Some(join),
    })
}

impl Drop for ClickTap {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(run_loop) = self.run_loop.take() {
            run_loop.stop();
        }
        if let Some(join) = self.join.take() {
            if let Err(error) = join.join() {
                tracing::warn!(?error, "trajectory click tap thread panicked");
            }
        }
    }
}

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

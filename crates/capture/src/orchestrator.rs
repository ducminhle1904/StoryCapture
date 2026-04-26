//! Fallback orchestrator — tries the preferred native backend first,
//! falls back to xcap primary-display capture for eligible window
//! targets on start failure, and surfaces a degraded event on the 2nd
//! consecutive failure in a session.
//!
//! This is a helper — NOT a new `CaptureBackend` implementation. Callers
//! (the Tauri `start_capture` command) build the requested backend and
//! wire the orchestrator around it for the native → xcap path.

use crate::backend::CaptureBackend;
use crate::error::CaptureError;
use crate::events::CaptureEvent;
use crate::target::CaptureTarget;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Counts consecutive native→xcap fallbacks in a session. A successful
/// native start resets the counter. On the 2nd consecutive failure we emit
/// `WindowCaptureDegraded` so the UI can show the "Open System Settings /
/// Use full screen" modal.
#[derive(Clone, Default)]
pub struct FallbackCounter {
    consecutive_failures: Arc<AtomicU32>,
}

impl FallbackCounter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&self) {
        self.consecutive_failures.store(0, Ordering::Release);
    }

    /// Increment and return the new value.
    pub fn tick(&self) -> u32 {
        self.consecutive_failures.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn get(&self) -> u32 {
        self.consecutive_failures.load(Ordering::Acquire)
    }
}

/// Outcome of orchestrated start.
#[derive(Debug)]
pub enum OrchestratedStart {
    /// The preferred native backend started successfully.
    Native,
    /// Native start failed; xcap took over for the primary display.
    FellBackToXcap { reason: String },
}

fn is_silent_fallback_eligible(target: &CaptureTarget) -> bool {
    matches!(
        target,
        CaptureTarget::Window { .. } | CaptureTarget::WindowByPid { .. }
    )
}

fn build_xcap_fallback_config(
    cfg: &crate::backend::CaptureConfig,
    displays: &[crate::display::DisplayInfo],
) -> Result<crate::backend::CaptureConfig, CaptureError> {
    let primary = displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| displays.first())
        .ok_or_else(|| CaptureError::Native("no displays available for fallback".into()))?
        .id;

    let mut fallback_cfg = cfg.clone();
    fallback_cfg.target = CaptureTarget::Display {
        display_id: primary,
    };
    Ok(fallback_cfg)
}

/// Attempt a native-backed start for `cfg`. On eligible window-target
/// errors, fall back to an xcap backend bound to the primary display and
/// emit appropriate events through `event_sink`.
///
/// Returns the backend that actually started so the caller can stop it
/// at session end.
pub async fn orchestrate_start(
    preferred: Box<dyn CaptureBackend>,
    cfg: crate::backend::CaptureConfig,
    out: mpsc::Sender<crate::frame::Frame>,
    event_sink: Option<mpsc::UnboundedSender<CaptureEvent>>,
    counter: FallbackCounter,
) -> Result<(Box<dyn CaptureBackend>, OrchestratedStart), CaptureError> {
    let mut preferred = preferred;
    match preferred.start(cfg.clone(), out.clone()).await {
        Ok(()) => {
            counter.reset();
            Ok((preferred, OrchestratedStart::Native))
        }
        Err(primary_err) => {
            let reason = primary_err.to_string();
            tracing::warn!(reason = %reason, "Native capture start failed — trying xcap fallback");

            // Only window-targeted captures should silently fall back;
            // display and region-targeted failures must preserve the
            // caller's original target contract.
            if !is_silent_fallback_eligible(&cfg.target) {
                return Err(primary_err);
            }

            // Build an xcap backend for the primary display (best-effort).
            let displays = crate::display::enumerate_displays()?;
            let fallback_cfg = build_xcap_fallback_config(&cfg, &displays)?;

            let mut xcap_backend: Box<dyn CaptureBackend> = Box::new(crate::XcapBackend::new());
            xcap_backend
                .start(fallback_cfg, out)
                .await
                .map_err(|e| CaptureError::Backend(format!("xcap fallback failed: {e}")))?;

            let failures = counter.tick();
            if let Some(tx) = event_sink.as_ref() {
                let _ = tx.send(CaptureEvent::WindowCaptureFellBack {
                    reason: reason.clone(),
                });
                if failures >= 2 {
                    let _ = tx.send(CaptureEvent::WindowCaptureDegraded {
                        reason: reason.clone(),
                    });
                }
            }

            Ok((xcap_backend, OrchestratedStart::FellBackToXcap { reason }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{BackendKind, CaptureConfig, CaptureStats};
    use crate::display::{DisplayId, DisplayInfo};
    use crate::frame::Frame;
    use async_trait::async_trait;
    use std::sync::atomic::AtomicBool;

    struct FailingBackend {
        fail_with: &'static str,
    }

    #[async_trait]
    impl CaptureBackend for FailingBackend {
        fn kind(&self) -> BackendKind {
            BackendKind::Native
        }
        async fn start(
            &mut self,
            _cfg: CaptureConfig,
            _out: mpsc::Sender<Frame>,
        ) -> Result<(), CaptureError> {
            Err(CaptureError::Backend(self.fail_with.into()))
        }
        async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
            Ok(CaptureStats::default())
        }
        fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
            Ok(vec![])
        }
    }

    struct OkBackend {
        started: Arc<AtomicBool>,
    }

    #[async_trait]
    impl CaptureBackend for OkBackend {
        fn kind(&self) -> BackendKind {
            BackendKind::Native
        }
        async fn start(
            &mut self,
            _cfg: CaptureConfig,
            _out: mpsc::Sender<Frame>,
        ) -> Result<(), CaptureError> {
            self.started.store(true, Ordering::Release);
            Ok(())
        }
        async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
            Ok(CaptureStats::default())
        }
        fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
            Ok(vec![])
        }
    }

    #[tokio::test]
    async fn fallback_orchestrator_display_target_propagates_error() {
        let counter = FallbackCounter::new();
        let (tx, _rx) = mpsc::channel::<Frame>(4);
        let backend: Box<dyn CaptureBackend> = Box::new(FailingBackend {
            fail_with: "primary failed",
        });
        let cfg = CaptureConfig::new(DisplayId(0));
        let result = orchestrate_start(backend, cfg, tx, None, counter.clone()).await;
        assert!(result.is_err(), "display-target failure must NOT fall back");
        assert_eq!(counter.get(), 0, "counter untouched on non-window path");
    }

    #[tokio::test]
    async fn fallback_orchestrator_display_region_target_propagates_error() {
        let counter = FallbackCounter::new();
        let (tx, _rx) = mpsc::channel::<Frame>(4);
        let backend: Box<dyn CaptureBackend> = Box::new(FailingBackend {
            fail_with: "primary failed",
        });
        let cfg = CaptureConfig::new_for_target(CaptureTarget::DisplayRegion {
            display_id: DisplayId(7),
            rect: crate::RegionRect {
                x: 10.0,
                y: 20.0,
                w: 640.0,
                h: 360.0,
            },
        });
        let result = orchestrate_start(backend, cfg, tx, None, counter.clone()).await;
        assert!(
            result.is_err(),
            "display-region failure must NOT silently degrade to full display"
        );
        assert_eq!(counter.get(), 0, "counter untouched on region path");
    }

    #[test]
    fn fallback_orchestrator_only_allows_window_targets() {
        assert!(!is_silent_fallback_eligible(&CaptureTarget::Display {
            display_id: DisplayId(1),
        }));
        assert!(is_silent_fallback_eligible(&CaptureTarget::Window {
            window_id: crate::WindowId(1),
        }));
        assert!(is_silent_fallback_eligible(&CaptureTarget::WindowByPid {
            pid: 42,
            title_hint: Some("Browser".into()),
        }));
        assert!(!is_silent_fallback_eligible(
            &CaptureTarget::DisplayRegion {
                display_id: DisplayId(1),
                rect: crate::RegionRect {
                    x: 0.0,
                    y: 0.0,
                    w: 100.0,
                    h: 100.0
                },
            }
        ));
    }

    #[test]
    fn fallback_orchestrator_rewrites_window_targets_to_primary_display() {
        let cfg = CaptureConfig::new_for_target(CaptureTarget::Window {
            window_id: crate::WindowId(9),
        });
        let displays = vec![
            DisplayInfo {
                id: DisplayId(2),
                name: "External".into(),
                width_px: 2560,
                height_px: 1440,
                scale_factor: 1.0,
                is_primary: false,
            },
            DisplayInfo {
                id: DisplayId(5),
                name: "Internal".into(),
                width_px: 3024,
                height_px: 1964,
                scale_factor: 2.0,
                is_primary: true,
            },
        ];

        let fallback_cfg = build_xcap_fallback_config(&cfg, &displays).expect("fallback config");

        assert_eq!(
            fallback_cfg.target,
            CaptureTarget::Display {
                display_id: DisplayId(5)
            }
        );
        assert_eq!(fallback_cfg.include_cursor, cfg.include_cursor);
        assert_eq!(fallback_cfg.fps_target, cfg.fps_target);
        assert_eq!(fallback_cfg.pixel_format, cfg.pixel_format);
        assert_eq!(fallback_cfg.queue_cap_bytes, cfg.queue_cap_bytes);
    }

    #[tokio::test]
    async fn fallback_orchestrator_resets_counter_on_success() {
        let counter = FallbackCounter::new();
        counter.tick(); // pretend we failed once before
        assert_eq!(counter.get(), 1);

        let started = Arc::new(AtomicBool::new(false));
        let backend: Box<dyn CaptureBackend> = Box::new(OkBackend {
            started: started.clone(),
        });
        let (tx, _rx) = mpsc::channel::<Frame>(4);
        let cfg = CaptureConfig::new_for_target(CaptureTarget::Window {
            window_id: crate::WindowId(1),
        });
        let (_b, outcome) = orchestrate_start(backend, cfg, tx, None, counter.clone())
            .await
            .expect("start ok");
        assert!(matches!(outcome, OrchestratedStart::Native));
        assert_eq!(counter.get(), 0, "success resets counter");
        assert!(started.load(Ordering::Acquire));
    }
}

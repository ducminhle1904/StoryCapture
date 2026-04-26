// Dry-Run orchestrator module.
//
// Drives `BrowserDriver` through DSL steps without screen capture or
// FFmpeg encode. Emits per-step status events + selector fallback chain
// to the webview via `DryRunEvent`. Takes seconds rather than the full
// record cycle, enabling rapid selector debugging.

// TODO: When crates/automation is available, replace this re-export
//       with `pub use automation::{BrowserDriver, DriverError, ...};`
#[cfg(feature = "phase1-wired")]
pub use automation::{BrowserDriver, DriverError, ExecStep, SelectorAttempt, StepResult};

#[cfg(not(feature = "phase1-wired"))]
pub mod trait_stub;
#[cfg(not(feature = "phase1-wired"))]
pub use trait_stub::{BrowserDriver, DriverError, ExecStep, SelectorAttempt, StepResult};

pub mod orchestrator;
pub use orchestrator::{run, DryRunEvent, DryRunOrchestrator};

//! `automation` — `BrowserDriver` trait + Playwright sidecar driver.
//!
//! **Pure crate:** zero Tauri imports; the headless CLI consumes this crate
//! unchanged.
//!
//! ## Architecture
//!
//! - [`BrowserDriver`] — async trait every driver implements.
//! - [`PlaywrightSidecarDriver`] — primary driver, Node SEA bundled, JSON-RPC.
//! - [`NoopDriver`] — fallback stub used when only one real driver exists.
//! - [`Executor`] — DSL → driver dispatch with capability-routing,
//!   per-verb auto-wait, and intent-aware selector resolution.
//! - [`SmartSelector`] — explicit-strict + ranked-text resolution.
//! - [`SessionActor`] — actor wrap for the recorder UI to drive.

pub mod auto_wait;
pub mod capability;
pub mod control;
pub mod driver;
pub mod error;
pub mod events;
pub mod executor;
pub mod noop_driver;
pub mod playwright_driver;
pub mod selector;
pub mod session;
pub mod targets_store;

pub use control::RunControl;
pub use driver::{
    ActionKind, BoundingBox, BrowserDriver, Capability, CapabilitySet, ElementState, LaunchConfig,
    LaunchOptions, ResolvedSelector,
};
pub use error::{AutomationError, Result};
pub use events::{
    AttemptLog, AttemptOutcome, ExecutorEvent, MatchKind, SelectorStrategy, StepFrame, StorySummary,
};
pub use executor::{continue_run, try_promote_fallback, Executor, PersistenceHandle};
pub use noop_driver::NoopDriver;
pub use playwright_driver::{
    BrowserProcessInfo, NavSnapshot, Notification, PickCandidate, PickElementMeta,
    PickElementResponse, PickLocator, PlaywrightSidecarDriver, PreviewFrame, SnapshotResponse,
};
pub use selector::{SmartSelector, ValidationResult};
pub use session::{
    NullRecorderHandle, RecorderHandle, SessionActor, SessionCmd, SessionId, SessionStatusSnapshot,
};

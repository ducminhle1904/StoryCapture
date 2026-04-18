//! `automation` — `BrowserDriver` trait + Playwright sidecar driver.
//!
//! **Pure crate (D-07):** zero Tauri imports; Phase 5's headless CLI
//! consumes this crate unchanged.
//!
//! ## Architecture
//!
//! - [`BrowserDriver`] — async trait every driver implements.
//! - [`PlaywrightSidecarDriver`] — primary driver, Node SEA bundled, JSON-RPC.
//! - [`NoopDriver`] — fallback stub used when only one real driver exists.
//! - [`Executor`] — DSL → driver dispatch with capability-routing (D-14)
//!   + per-verb auto-wait (D-12) + intent-aware selector resolution (D-13).
//! - [`SmartSelector`] — explicit-strict + ranked-text resolution.
//! - [`SessionActor`] — D-06 actor wrap for the recorder UI to drive.

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

pub use driver::{
    ActionKind, BoundingBox, BrowserDriver, Capability, CapabilitySet, ElementState, LaunchConfig,
    LaunchOptions, ResolvedSelector,
};
pub use control::RunControl;
pub use error::{AutomationError, Result};
pub use events::{AttemptLog, AttemptOutcome, ExecutorEvent, SelectorStrategy, StorySummary};
pub use executor::{Executor, PersistenceHandle};
pub use noop_driver::NoopDriver;
pub use playwright_driver::{
    BrowserProcessInfo, Notification, PickCandidate, PickElementResponse, PickLocator,
    PlaywrightSidecarDriver, SnapshotResponse,
};
pub use selector::{SmartSelector, ValidationResult};
pub use session::{
    NullRecorderHandle, RecorderHandle, SessionActor, SessionCmd, SessionId, SessionStatusSnapshot,
};

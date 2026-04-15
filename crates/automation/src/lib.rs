//! `automation` — `BrowserDriver` trait + chromiumoxide / Playwright sidecar drivers.
//!
//! **Pure crate (D-07/D-11):** zero Tauri imports; Phase 5's headless CLI
//! consumes this crate unchanged.
//!
//! ## Architecture
//!
//! - [`BrowserDriver`] — async trait every driver implements.
//! - [`ChromiumoxideDriver`] — primary, in-process CDP (chromiumoxide 0.7).
//! - [`PlaywrightSidecarDriver`] — fallback, Node SEA bundled, JSON-RPC.
//! - [`Executor`] — DSL → driver dispatch with capability-routing (D-14)
//!   + per-verb auto-wait (D-12) + intent-aware selector resolution (D-13).
//! - [`SmartSelector`] — explicit-strict + ranked-text resolution.
//! - [`SessionActor`] — D-06 actor wrap for the recorder UI to drive.

pub mod auto_wait;
pub mod capability;
pub mod chromiumoxide_driver;
pub mod driver;
pub mod error;
pub mod events;
pub mod executor;
pub mod playwright_driver;
pub mod selector;
pub mod session;

pub use chromiumoxide_driver::ChromiumoxideDriver;
pub use driver::{
    ActionKind, BoundingBox, BrowserDriver, Capability, CapabilitySet, ElementState, LaunchConfig,
    ResolvedSelector,
};
pub use error::{AutomationError, Result};
pub use events::{AttemptLog, AttemptOutcome, ExecutorEvent, SelectorStrategy, StorySummary};
pub use executor::{Executor, PersistenceHandle};
pub use playwright_driver::PlaywrightSidecarDriver;
pub use selector::SmartSelector;
pub use session::{SessionActor, SessionCmd, SessionId, SessionStatusSnapshot};

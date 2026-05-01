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

pub mod action_timeline;
pub mod auto_wait;
pub mod capability;
pub mod control;
pub mod driver;
pub mod error;
pub mod events;
pub mod executor;
pub mod noop_driver;
pub mod pacing;
pub mod playwright_driver;
pub mod selector;
pub mod session;
pub mod targets_store;

pub use action_timeline::{
    sidecar_path_for as action_timeline_sidecar_path_for, write_atomic as write_action_timeline,
    ActionCaptureRect, ActionPoint, ActionPointer, ActionTarget, ActionTimelineDto,
    ActionTimelineEvent, PointerButton, ACTION_TIMELINE_VERSION,
};
pub use control::RunControl;
pub use driver::{
    accept_language_for_locale, is_supported_browser_locale, ActionKind, BoundingBox,
    BrowserDriver, BrowserEnvironment, BrowserLanguageChoice, BrowserLanguageOption,
    BrowserSessionProfile, Capability, CapabilitySet, ElementState, LaunchConfig, LaunchOptions,
    ResolvedSelector, WindowPosition, BROWSER_LANGUAGE_OPTIONS, BROWSER_LANGUAGE_SYSTEM,
};
pub use error::{AutomationError, Result};
pub use events::{
    AttemptLog, AttemptOutcome, ExecutorEvent, MatchKind, SelectorStrategy, StepFrame, StorySummary,
};
pub use executor::{continue_run, try_promote_fallback, Executor, PersistenceHandle};
pub use noop_driver::NoopDriver;
pub use pacing::{PacingConfig, PacingProfile};
pub use playwright_driver::{
    BrowserProcessInfo, NavSnapshot, Notification, PickCandidate, PickElementMeta,
    PickElementResponse, PickLocator, PlaywrightSidecarDriver, PreviewFrame, SnapshotResponse,
};
pub use selector::{SmartSelector, ValidationResult};
pub use session::{
    NullRecorderHandle, RecorderHandle, SessionActor, SessionCmd, SessionId, SessionStatusSnapshot,
};

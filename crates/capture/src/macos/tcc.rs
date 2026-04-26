//! macOS Screen Recording TCC (Transparency, Consent and Control) flow.
//!
//! Stale TCC entries ("ghost grants") happen when the dev signing
//! identity changes between builds. The Tauri host
//! must:
//!   1. Call `preflight_screen_capture_access()` on launch.
//!   2. If denied, surface a guided modal in the UI ("Open System
//!      Settings → Privacy & Security → Screen Recording") and link to
//!      `TCC_PREFS_URL`.
//!   3. After the user grants, call `relaunch_after_grant()` — Sequoia
//!      requires a relaunch for the new grant to attach to the running
//!      process.
//!
//! This module is FFI-only; the Tauri command shim lives in
//! `apps/desktop/src-tauri/src/commands/capture.rs`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionState {
    Granted,
    Denied,
    Undetermined,
}

/// Deep link to the Screen Recording pane (Ventura+/Sonoma/Sequoia).
pub const TCC_PREFS_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// Returns `Granted` iff the OS reports the calling process is
    /// already allowed to capture the screen. Returns `Denied` otherwise
    /// — `CGPreflightScreenCaptureAccess` does not distinguish between
    /// "denied" and "undetermined", so we surface both as `Denied` and
    /// let the UI present the guided prompt.
    pub fn preflight_screen_capture_access() -> PermissionState {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            PermissionState::Granted
        } else {
            PermissionState::Denied
        }
    }

    /// Triggers the system permission prompt. Returns `true` if the user
    /// has already granted (no prompt shown).
    pub fn request_access() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    /// On non-macOS targets we treat screen capture as unconditionally
    /// granted (Windows uses its own consent UI; the helper exists only
    /// so cross-platform code can call this without `cfg` arms).
    pub fn preflight_screen_capture_access() -> PermissionState {
        PermissionState::Granted
    }

    pub fn request_access() -> bool {
        true
    }
}

pub use imp::{preflight_screen_capture_access, request_access};

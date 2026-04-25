// system.rs — host-level smoke commands (Phase 1 plan 01-03).
//
//   * ping             — round-trip sanity check
//   * app_info         — version / platform / data dir for the renderer
//   * store_secret     — write to OS keychain (T-03-02: value never logged)
//   * load_secret      — read from OS keychain
//   * delete_secret    — clean up after smoke tests
//   * trigger_panic    — DEBUG ONLY; panics on a worker thread to prove
//                        the panic hook + UI modal flow works end-to-end
//
// Per D-29 we use the `keyring` crate directly (community
// `tauri-plugin-keyring` is not always on crates.io; the underlying Rust
// binding is identical and satisfies the requirement). All five commands
// are `#[tauri::command]` AND `#[specta::specta]` so tauri-specta picks
// them up for TS codegen.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Wry};

use crate::error::AppError;

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub data_dir: String,
    pub log_dir: String,
    /// Per-process session id (matches the `session=<uuid>` prefix on every
    /// log line). Surfaced to the renderer so bug-report bundles can
    /// reference the exact slice of the log file the user is running in.
    pub session_id: String,
    pub pid: u32,
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "ping"))]
pub fn ping() -> String {
    "pong from storycapture".to_string()
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "app_info"), err(Debug))]
pub fn app_info(app: AppHandle<Wry>) -> Result<AppInfo, AppError> {
    let state = app.state::<crate::state::AppState>();
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: state.data_dir.display().to_string(),
        log_dir: state.log_dir.display().to_string(),
        session_id: crate::logging::current_session_id().to_string(),
        pid: std::process::id(),
    })
}

// `value` is `skip`-ped from any tracing instrumentation we ever add.
// Callers MUST NEVER log the cleartext secret; the only reason it crosses
// the IPC boundary is so the renderer can hand a key entered by the user
// straight to the OS keychain without persisting it elsewhere.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "store_secret"), err(Debug))]
pub fn store_secret(service: String, account: String, value: String) -> Result<(), AppError> {
    tracing::info!(
        target: "storycapture::secrets",
        service = %service,
        account = %account,
        "storing secret (value redacted)"
    );
    let entry = keyring::Entry::new(&service, &account)?;
    entry.set_password(&value)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "load_secret"), err(Debug))]
pub fn load_secret(service: String, account: String) -> Result<String, AppError> {
    tracing::info!(
        target: "storycapture::secrets",
        service = %service,
        account = %account,
        "loading secret"
    );
    let entry = keyring::Entry::new(&service, &account)?;
    Ok(entry.get_password()?)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "delete_secret"), err(Debug))]
pub fn delete_secret(service: String, account: String) -> Result<(), AppError> {
    tracing::info!(
        target: "storycapture::secrets",
        service = %service,
        account = %account,
        "deleting secret"
    );
    let entry = keyring::Entry::new(&service, &account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // idempotent
        Err(e) => Err(e.into()),
    }
}

/// Smoke command — panics on a worker thread so we can prove the panic
/// hook in `panic_hook.rs` catches cross-thread panics and emits the
/// `app:panic` event to the renderer.
///
/// In release builds this is a no-op that returns
/// `AppError::InvalidArgument("trigger_panic disabled in release")` —
/// the renderer button is hidden in release UIs. This keeps the IPC
/// surface stable across debug/release so `tauri-specta`-generated TS
/// bindings don't drift between profiles.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "trigger_panic"), err(Debug))]
pub fn trigger_panic() -> Result<(), AppError> {
    #[cfg(debug_assertions)]
    {
        tracing::warn!(target: "storycapture::panic", "trigger_panic invoked — about to panic on a worker thread");
        std::thread::Builder::new()
            .name("trigger-panic-worker".to_string())
            .spawn(|| {
                panic!("trigger_panic: synthetic panic for hook verification");
            })
            .map_err(|e| AppError::Internal(format!("failed to spawn panic thread: {e}")))?;
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        Err(AppError::InvalidArgument(
            "trigger_panic disabled in release builds".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong from storycapture");
    }

    /// Round-trip a secret through the OS keychain. Skipped on CI where
    /// no keychain is unlocked (Linux Secret Service in particular needs
    /// a session). Run locally with `cargo test --package storycapture
    /// keyring_round_trip -- --ignored`.
    #[test]
    #[ignore]
    fn keyring_round_trip() {
        let service = "com.storycapture.tests".to_string();
        let account = format!("plan-01-03-test-{}", uuid::Uuid::new_v4());
        let value = "round-trip-secret-do-not-log".to_string();

        store_secret(service.clone(), account.clone(), value.clone()).expect("store");
        let loaded = load_secret(service.clone(), account.clone()).expect("load");
        assert_eq!(loaded, value);
        delete_secret(service, account).expect("delete");
    }
}

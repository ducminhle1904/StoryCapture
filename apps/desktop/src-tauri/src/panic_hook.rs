// Panic hook.
//
// Catches every panic in every thread, writes the panic message + a forced
// backtrace to the tracing log at ERROR level, then emits a Tauri event
// `app:panic` so the renderer can show a "restart & report" modal. Chains
// to the default hook so stderr still receives the panic for `cargo run`
// usability.
//
// Sanitization: the panic payload sent to the renderer contains ONLY the
// panic message string and the panicking thread name. Backtrace + locals
// stay in the local log file (no PII / no keychain values leaked through
// the panic surface).

use std::{
    backtrace::Backtrace,
    panic::{self, PanicHookInfo},
    sync::Arc,
};

use once_cell::sync::OnceCell;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Wry};

static APP_HANDLE: OnceCell<Arc<AppHandle<Wry>>> = OnceCell::new();

#[derive(Serialize, Clone, specta::Type)]
pub struct PanicPayload {
    /// Sanitized panic message. Backtrace is NOT included (file-only).
    pub message: String,
    /// Name of the thread that panicked, or "unknown".
    pub thread: String,
}

pub fn install(app_handle: AppHandle<Wry>) {
    if APP_HANDLE.set(Arc::new(app_handle)).is_err() {
        // Already installed — happens in test contexts where `run()` is
        // re-entered. Leave the existing hook in place.
        tracing::warn!(target: "storycapture::panic", "panic hook already installed; skipping re-install");
        return;
    }

    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info: &PanicHookInfo<'_>| {
        let payload = extract_message(info);
        let thread = std::thread::current()
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let backtrace = Backtrace::force_capture();

        // 1. Local log (full backtrace; never sent across IPC).
        // session_id is implicit in the formatter prefix; we re-emit it
        // in the structured field so a panic line is grep-friendly even
        // if the formatter is ever stripped.
        tracing::error!(
            target: "storycapture::panic",
            session_id = %crate::logging::current_session_id(),
            thread = %thread,
            location = ?info.location(),
            "PANIC: {payload}\n{backtrace}"
        );

        // 2. UI emit (sanitized — no backtrace, no locals).
        if let Some(app) = APP_HANDLE.get() {
            let evt = PanicPayload {
                message: payload.clone(),
                thread: thread.clone(),
            };
            if let Err(e) = app.emit("app:panic", evt) {
                tracing::error!(target: "storycapture::panic", "failed to emit app:panic event: {e}");
            }
        }

        // 3. Chain to default hook (writes to stderr — useful for `cargo run`).
        default_hook(info);
    }));
}

fn extract_message(info: &PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        format!("non-string panic payload at {:?}", info.location())
    }
}

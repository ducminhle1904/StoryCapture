//! Bridge so the React renderer can emit structured events into the
//! canonical `tracing` log file (target `storycapture::frontend`).
//!
//! Frontend usage: `apps/desktop/src/lib/log.ts` `frontendLog.{level}(...)`.
//! Each event renders as e.g.:
//!
//! ```text
//! 2026-04-25T10:15:33Z ERROR storycapture::frontend source=RegionOverlay
//!   reason="getDisplayMedia rejected" stack="…" "frontend error"
//! ```

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum FrontendLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FrontendLogPayload {
    pub level: FrontendLogLevel,
    /// Originating component / module — e.g. `"RegionOverlay"`. Free-form.
    pub source: String,
    pub message: String,
    /// Dynamic key/value pairs rendered into the event tail as `key="value"`.
    /// `tracing`'s static field machinery can't accept runtime field names,
    /// hence the string-tuple shape.
    #[serde(default)]
    pub fields: Vec<(String, String)>,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

// No `#[tracing::instrument]` here — this command IS the logging primitive,
// so adding an entry span would double every frontend event in the file.
#[tauri::command]
#[specta::specta]
pub async fn log_from_frontend(payload: FrontendLogPayload) -> Result<(), AppError> {
    let FrontendLogPayload {
        level,
        source,
        message,
        fields,
        stack,
        url,
    } = payload;

    let mut tail = String::new();
    for (k, v) in &fields {
        let _ = write!(&mut tail, " {k}={v:?}");
    }
    if let Some(u) = url.as_deref() {
        let _ = write!(&mut tail, " url={u:?}");
    }
    if let Some(s) = stack.as_deref() {
        if !s.is_empty() {
            let _ = write!(&mut tail, " stack={s:?}");
        }
    }

    // `tracing::event!` requires a const level, so dispatch via a local
    // macro to keep the per-arm body identical and the structured
    // `source = …` field consistent across levels.
    macro_rules! emit_at {
        ($lvl:expr) => {
            tracing::event!(
                target: "storycapture::frontend",
                $lvl,
                source = %source,
                "{message}{tail}"
            )
        };
    }
    match level {
        FrontendLogLevel::Trace => emit_at!(tracing::Level::TRACE),
        FrontendLogLevel::Debug => emit_at!(tracing::Level::DEBUG),
        FrontendLogLevel::Info => emit_at!(tracing::Level::INFO),
        FrontendLogLevel::Warn => emit_at!(tracing::Level::WARN),
        FrontendLogLevel::Error => emit_at!(tracing::Level::ERROR),
    }
    Ok(())
}

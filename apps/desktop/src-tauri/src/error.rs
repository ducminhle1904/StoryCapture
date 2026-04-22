// AppError — common IPC error taxonomy (D-31).
//
// Every Tauri command returns `Result<T, AppError>`; serializes to the
// renderer as a tagged JSON object: `{ "kind": "Io", "message": "..." }`.
//
// All long-running domain crates (automation, capture, encoder, storage)
// return their own typed errors (thiserror); the Tauri command boundary
// converts those into `AppError` via `From` impls. `anyhow::Error` is
// accepted at the boundary and folded into `AppError::Internal`.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("io error: {0}")]
    Io(String),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("keyring error: {0}")]
    Keyring(String),

    #[error("automation error: {0}")]
    Automation(String),

    #[error("capture error: {0}")]
    Capture(String),

    #[error("encoder error: {0}")]
    Encoder(String),

    #[error("storage error: {0}")]
    Storage(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("internal error: {0}")]
    Internal(String),

    #[error("unavailable on backend: {0}")]
    UnavailableOnBackend(String),

    /// D-04: another `start_recording` is already in-flight. The global
    /// `compare_exchange` guard at the command entry returns this when a
    /// concurrent caller beats the current one. Frontend treats this as a
    /// benign no-op (retry is the user clicking Start again).
    #[error("a recording is already starting")]
    AlreadyStarting,
}

// Manual Serialize impl produces the `{ kind, message }` shape that matches
// the `#[derive(specta::Type)]` TS output. (We can't `#[derive(Serialize)]`
// directly on a thiserror enum and keep the doc-comment-friendly variant
// shape AND match specta's TS taxonomy, so we hand-roll it — the result is
// stable and exercised by an integration test.)
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (kind, message) = match self {
            AppError::Io(m) => ("Io", m.as_str()),
            AppError::Serialization(m) => ("Serialization", m.as_str()),
            AppError::Keyring(m) => ("Keyring", m.as_str()),
            AppError::Automation(m) => ("Automation", m.as_str()),
            AppError::Capture(m) => ("Capture", m.as_str()),
            AppError::Encoder(m) => ("Encoder", m.as_str()),
            AppError::Storage(m) => ("Storage", m.as_str()),
            AppError::NotFound(m) => ("NotFound", m.as_str()),
            AppError::InvalidArgument(m) => ("InvalidArgument", m.as_str()),
            AppError::Internal(m) => ("Internal", m.as_str()),
            AppError::UnavailableOnBackend(m) => ("UnavailableOnBackend", m.as_str()),
            AppError::AlreadyStarting => ("AlreadyStarting", "a recording is already starting"),
        };
        let mut s = ser.serialize_struct("AppError", 2)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", message)?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Serialization(e.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Keyring(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<storage::StorageError> for AppError {
    fn from(e: storage::StorageError) -> Self {
        AppError::Storage(e.to_string())
    }
}

impl From<encoder::EncoderError> for AppError {
    fn from(e: encoder::EncoderError) -> Self {
        AppError::Encoder(e.to_string())
    }
}

impl From<effects::EffectsError> for AppError {
    fn from(e: effects::EffectsError) -> Self {
        AppError::Internal(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_kind_message() {
        let err = AppError::Io("boom".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, r#"{"kind":"Io","message":"boom"}"#);
    }

    #[test]
    fn anyhow_folds_to_internal() {
        let any = anyhow::anyhow!("oops");
        let app: AppError = any.into();
        match app {
            AppError::Internal(m) => assert_eq!(m, "oops"),
            other => panic!("expected Internal, got {other:?}"),
        }
    }
}

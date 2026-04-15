//! Storage error taxonomy. Pure crate — no Tauri imports.

use serde::Serialize;
use thiserror::Error;

/// All errors returned by the storage crate.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum StorageError {
    #[error("io error: {0}")]
    Io(String),

    #[error("sqlite error: {0}")]
    Sqlite(String),

    #[error("migration error: {0}")]
    Migration(String),

    /// Raised when the on-disk schema version does not match the version this
    /// build of the app supports (either older — should have been migrated — or
    /// newer than supported, which would risk silent data corruption).
    #[error("schema version mismatch: expected {expected}, found {found}")]
    SchemaVersionMismatch { expected: u32, found: u32 },

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid project folder: {0}")]
    InvalidProjectFolder(String),

    #[error("already exists: {0}")]
    AlreadyExists(String),

    #[error("serialization error: {0}")]
    Serialization(String),
}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        StorageError::Io(e.to_string())
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        StorageError::Sqlite(e.to_string())
    }
}

impl From<rusqlite_migration::Error> for StorageError {
    fn from(e: rusqlite_migration::Error) -> Self {
        StorageError::Migration(e.to_string())
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(e: serde_json::Error) -> Self {
        StorageError::Serialization(e.to_string())
    }
}

#![deny(rust_2018_idioms)]
#![warn(clippy::all)]

pub mod error;
pub mod http;
pub mod secrets;
pub mod tracing; // redaction layer
pub mod dryrun;
pub mod llm;
pub mod lsp;
pub mod nl;
pub mod tts;

pub use error::IntelError;
pub use secrets::Redacted;

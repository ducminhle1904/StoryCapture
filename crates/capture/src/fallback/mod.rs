//! Cross-platform xcap-based fallback. The third option; primary backends
//! are always tried first.

pub mod xcap_backend;

pub use xcap_backend::XcapBackend;

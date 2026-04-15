//! Cross-platform xcap-based fallback. Documented (D-18) as the third
//! option; primary backends are always tried first.

pub mod xcap_backend;

pub use xcap_backend::XcapBackend;

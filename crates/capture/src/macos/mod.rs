//! macOS-specific capture: ScreenCaptureKit backend + TCC permission UX.

pub mod raii;
pub mod sck_backend;
pub mod tcc;

pub use sck_backend::SckBackend;

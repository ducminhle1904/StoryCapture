//! macOS-specific capture: ScreenCaptureKit backend + TCC permission UX.

pub mod frame_from_sample;
pub mod raii;
pub mod sck_backend;
pub mod screenshot;
pub mod tcc;
pub mod window;

pub use sck_backend::SckBackend;

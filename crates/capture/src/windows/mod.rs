//! Windows-specific capture: Windows.Graphics.Capture backend +
//! D3D11 texture RAII.

pub mod raii;
pub mod wgc_backend;

pub use wgc_backend::WgcBackend;

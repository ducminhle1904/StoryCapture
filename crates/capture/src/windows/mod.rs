//! Windows-specific capture: Windows.Graphics.Capture backend +
//! window enumeration + D3D11 texture RAII.

pub mod frame_from_wgc;
pub mod raii;
pub mod wgc_backend;
pub mod window;

pub use wgc_backend::WgcBackend;

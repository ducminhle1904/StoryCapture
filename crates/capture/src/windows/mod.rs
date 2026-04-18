//! Windows-specific capture: Windows.Graphics.Capture backend +
//! window enumeration + D3D11 texture RAII.

pub mod frame_from_wgc;
pub(crate) mod helpers;
pub mod pool;
pub mod raii;
pub mod thumbnail;
pub mod wgc_backend;
pub mod window;

pub use wgc_backend::WgcBackend;

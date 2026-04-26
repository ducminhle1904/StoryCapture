//! Scene transitions. `XfadeTimeline` centralises offset math, and
//! `xfade.rs` / `opencl_probe.rs` cover emission + runtime feature
//! detection.

pub mod opencl_probe;
pub mod timeline;
pub mod xfade;

pub use opencl_probe::{probe_from_stdout, probe_xfade_opencl, OpenClAvailability};
pub use timeline::{compute_offsets, XfadeTimeline};
pub use xfade::{emit_xfade, kind_supports_opencl};

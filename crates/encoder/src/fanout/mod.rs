//! Smart batch reuse: render composite frames once to an FFV1 intermediate,
//! then fan-out to N parallel encoders (Plan 02-10 Task 3).

pub mod intermediate;
pub mod multi_encode;

pub use intermediate::{render_intermediate, IntermediateOutput};
pub use multi_encode::{
    bitrate_for, fanout_encode, resolution_width, FanoutPlan, OutputFormat, OutputSpec, Quality,
    Resolution,
};

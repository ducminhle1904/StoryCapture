//! Smart batch reuse: render composite frames once to an FFV1 intermediate,
//! then fan-out to N parallel encoders.

pub mod intermediate;
pub mod multi_encode;

pub use intermediate::{build_intermediate_args, render_intermediate, IntermediateOutput};
pub use multi_encode::{
    bitrate_for, build_encode_args, default_h264_encoder, fanout_encode, resolution_height,
    resolution_width, FanoutPlan, OutputFormat, OutputSpec, Quality, Resolution,
};

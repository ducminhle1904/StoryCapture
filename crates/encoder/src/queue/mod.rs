//! Render queue actor (Plan 02-10). Task 2 fills this in.

pub mod actor;
pub mod job;

pub use actor::{spawn_render_queue, QueueMsg, RenderQueueActor, RenderQueueHandle};

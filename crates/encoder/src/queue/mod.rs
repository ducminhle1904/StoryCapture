//! Render queue actor.

pub mod actor;
pub mod job;

pub use actor::{
    open_project_conn, spawn_render_queue, QueueMsg, RenderQueueActor, RenderQueueConfig,
    RenderQueueHandle,
};
pub use job::{JobExecutor, JobOutcome, NoopJobExecutor, SharedExecutor};

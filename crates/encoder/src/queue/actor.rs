//! Placeholder filled in by Task 2.

use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug)]
pub enum QueueMsg {
    Enqueue(Uuid),
    Cancel(Uuid),
    Shutdown,
}

#[derive(Debug, Clone)]
pub struct RenderQueueHandle {
    pub tx: mpsc::Sender<QueueMsg>,
}

impl RenderQueueHandle {
    pub async fn send(&self, msg: QueueMsg) -> Result<()> {
        self.tx
            .send(msg)
            .await
            .map_err(|e| crate::error::EncoderError::Io(format!("queue send: {e}")))
    }
}

pub struct RenderQueueActor;

/// Task 2 will replace this placeholder with the full actor spawn.
pub async fn spawn_render_queue() -> RenderQueueHandle {
    let (tx, _rx) = mpsc::channel::<QueueMsg>(32);
    RenderQueueHandle { tx }
}

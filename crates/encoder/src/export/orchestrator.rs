//! Export orchestrator — Task 2 will flesh this out. Stubs live here so
//! `pub use` from `export::mod.rs` compiles during Task 1.

use std::path::PathBuf;
use uuid::Uuid;

use super::batch::OutputSpec;
use super::error::ExportError;

#[derive(Debug, Clone)]
pub struct ExportRequest {
    pub story_id: String,
    pub graph: effects::Graph,
    pub outputs: Vec<OutputSpec>,
    pub priority: i32,
    pub output_folder: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ExportResult {
    pub batch_id: Uuid,
    pub job_ids: Vec<Uuid>,
}

/// Placeholder; Task 2 replaces with the full enqueue-and-nudge path.
pub async fn export_run(_req: ExportRequest) -> Result<ExportResult, ExportError> {
    Err(ExportError::Io("export_run not yet implemented (Task 2)".into()))
}

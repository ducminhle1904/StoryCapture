// Fleshed out in Task 2.
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("placeholder")]
    Placeholder,
}

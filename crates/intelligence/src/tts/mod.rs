// Fleshed out in Task 2.
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TtsError {
    #[error("placeholder")]
    Placeholder,
}

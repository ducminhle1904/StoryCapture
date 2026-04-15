//! File-system IO helpers for the parser.
//!
//! Enforces the 10 MB size cap from threat T-04-01. Caller is responsible
//! for ensuring valid UTF-8 (rejected with InvalidData otherwise) — pest
//! requires `&str`, not raw bytes.

use std::path::Path;

use crate::parser::{parse, ParseResult};

/// Maximum `.story` file size we will load into memory (10 MB).
pub const MAX_STORY_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Read and parse a `.story` file from disk.
pub fn parse_file(path: &Path) -> std::io::Result<ParseResult> {
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > MAX_STORY_FILE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "story file {} exceeds {} byte cap (got {} bytes)",
                path.display(),
                MAX_STORY_FILE_BYTES,
                metadata.len()
            ),
        ));
    }
    let bytes = std::fs::read(path)?;
    let source = std::str::from_utf8(&bytes).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("story file {} is not valid UTF-8: {}", path.display(), e),
        )
    })?;
    Ok(parse(source))
}

//! Atomic output staging: write to `<target>.partial`, rename on success,
//! drop-cleanup on any failure path.

use std::path::{Path, PathBuf};

/// Derive the staging path for `target`, preserving the original extension
/// so FFmpeg / AVAssetWriter can auto-detect the output format:
/// `out.mp4` -> `out.partial.mp4`; `out` (no extension) -> `out.partial`.
/// Stays in the same directory as `target` so the subsequent rename is
/// guaranteed atomic (same filesystem).
pub fn partial_path_of(target: &Path) -> PathBuf {
    let stem = target.file_stem().unwrap_or_default();
    let mut name = std::ffi::OsString::from(stem);
    name.push(".partial");
    if let Some(ext) = target.extension() {
        name.push(".");
        name.push(ext);
    }
    match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.join(name),
        _ => PathBuf::from(name),
    }
}

/// RAII guard: removes a staging file unless `disarm()` is called first.
/// Consuming `disarm(mut self)` prevents accidental re-arm after a successful
/// rename.
pub(crate) struct PartialFileGuard {
    path: Option<PathBuf>,
}

impl PartialFileGuard {
    pub fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    pub fn disarm(mut self) {
        self.path.take();
    }
}

impl Drop for PartialFileGuard {
    fn drop(&mut self) {
        if let Some(p) = self.path.take() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_path_inserts_partial_before_extension() {
        let p = partial_path_of(Path::new("/tmp/out.mp4"));
        assert_eq!(p.as_os_str(), "/tmp/out.partial.mp4");
    }

    #[test]
    fn partial_path_appends_partial_when_no_extension() {
        let p = partial_path_of(Path::new("/tmp/out"));
        assert_eq!(p.as_os_str(), "/tmp/out.partial");
    }

    #[test]
    fn partial_guard_removes_file_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.partial");
        std::fs::write(&p, b"hello").unwrap();
        {
            let _g = PartialFileGuard::new(p.clone());
        }
        assert!(!p.exists(), "partial file must be removed on drop");
    }

    #[test]
    fn partial_guard_disarm_preserves_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("y.partial");
        std::fs::write(&p, b"hello").unwrap();
        {
            let g = PartialFileGuard::new(p.clone());
            g.disarm();
        }
        assert!(p.exists(), "disarmed guard must not delete file");
    }
}

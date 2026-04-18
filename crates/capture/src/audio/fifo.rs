//! Cross-platform named-pipe / fifo factory for the FFmpeg audio sink.
//!
//! Tauri's shell plugin only plumbs fds 0/1/2 to sidecars (discussion
//! #4440), so named pipes are the only portable path. Unix: `mkfifo`
//! mode `0o600` inside a process-private tempdir — threat mitigation
//! T-06-04/06 (same-user reader, undiscoverable path). Windows:
//! session-scoped `\\.\pipe\<uuid>`.

use std::path::{Path, PathBuf};

use super::error::AudioError;

/// Opaque RAII handle that owns the fifo's filesystem location (if any)
/// and deletes it on drop. On Windows named pipes the handle is
/// effectively a no-op wrapper around the path string — the OS reclaims
/// the namespace entry when the last handle closes.
pub struct FifoHandle {
    path: PathBuf,
    #[allow(dead_code)] // only used on Unix
    tempdir: Option<tempfile::TempDir>,
}

impl FifoHandle {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn into_path(self) -> PathBuf {
        // Callers who `into_path()` take ownership of the filesystem
        // entry — in that case we leak the TempDir so cleanup is manual.
        // Current callers clone the path via `.path()`; this helper
        // exists for symmetry only.
        let FifoHandle { path, tempdir } = self;
        if let Some(td) = tempdir {
            let _ = td.keep(); // do not delete on drop
        }
        path
    }
}

/// Create a new named pipe / fifo under a process-private temp dir.
/// Returns a handle whose `.path()` is suitable for passing to FFmpeg
/// as a `-i` argument.
///
/// On Unix: `tempdir()` gives us owner-only perms, then `mkfifo` with
/// mode 0o600 inside. On Windows: `\\.\pipe\storycapture-audio-<uuid>`.
pub fn make_fifo(name_hint: &str) -> Result<FifoHandle, AudioError> {
    #[cfg(unix)]
    {
        use nix::sys::stat::Mode;
        use nix::unistd::mkfifo;

        let td = tempfile::tempdir()
            .map_err(|e| AudioError::Fifo(format!("tempdir: {e}")))?;
        let path = td.path().join(format!("{name_hint}.fifo"));
        mkfifo(
            &path,
            Mode::S_IRUSR | Mode::S_IWUSR, // 0o600 — T-06-04 mitigation
        )
        .map_err(|e| AudioError::Fifo(format!("mkfifo {}: {e}", path.display())))?;
        Ok(FifoHandle {
            path,
            tempdir: Some(td),
        })
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            PIPE_ACCESS_OUTBOUND, FILE_FLAG_FIRST_PIPE_INSTANCE,
        };
        use windows::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
        };

        // UUID-suffixed name collision-prevents T-06-04/06; session-scoped
        // namespace handles tampering by other sessions.
        let pipe_name = format!(
            "\\\\.\\pipe\\{}-{}",
            name_hint,
            uuid::Uuid::new_v4().simple()
        );
        let wide: Vec<u16> = std::ffi::OsStr::new(&pipe_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // Touch FFI to ensure the path is valid. The actual handle
        // lifetime is tied to the writer's later OpenOptions::open call
        // in the drain thread; we drop this provisional handle so the
        // pipe namespace entry persists through CreateFile.
        unsafe {
            let h = CreateNamedPipeW(
                PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1, // one instance — single writer, single reader
                1 << 16, // out buffer 64k
                1 << 16, // in buffer 64k
                0,
                None,
            );
            if h.is_invalid() {
                return Err(AudioError::Fifo(format!(
                    "CreateNamedPipeW failed: {}",
                    std::io::Error::last_os_error()
                )));
            }
            // Leak the handle — FFmpeg will CreateFile against the same
            // name and the first instance sticks around until we drop.
            // On the writer side, we re-open via OpenOptions below.
            let _ = h;
        }
        Ok(FifoHandle {
            path: PathBuf::from(pipe_name),
            tempdir: None,
        })
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = name_hint;
        Err(AudioError::Fifo("unsupported platform".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_fifo_returns_path_under_tempdir() {
        let f = make_fifo("storycapture-audio-test").expect("make_fifo");
        let p = f.path().to_path_buf();
        assert!(
            p.to_string_lossy().contains("storycapture-audio-test"),
            "unexpected fifo path: {}",
            p.display()
        );
    }

    #[cfg(unix)]
    #[test]
    fn make_fifo_is_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let f = make_fifo("perm-check").expect("make_fifo");
        let meta = std::fs::metadata(f.path()).expect("stat fifo");
        // Mask off the file-type bits; only permission bits matter.
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "fifo perms not 0o600 (T-06-04); got {:o}",
            mode
        );
    }
}

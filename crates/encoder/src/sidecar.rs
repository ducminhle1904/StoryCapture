//! FFmpeg sidecar lifecycle.
//!
//! The `encoder` crate is pure (no `tauri` dep). The Tauri host resolves
//! the sidecar path via `tauri-plugin-shell`'s externalBin machinery and
//! injects a concrete `SidecarCommand` impl; tests inject the
//! `LocalFfmpegCommand` variant that shells out directly via
//! `tokio::process::Command`.
//!
//! `SidecarChild` is a thin RAII bundle of the four pieces every call
//! site needs: `stdin` (BGRA pump), `stdout` (probe output), `stderr`
//! (progress parser), and the `Child` handle for graceful shutdown.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};

use crate::error::{EncoderError, Result};

/// Trait injected by the Tauri host (or tests) to spawn an FFmpeg process
/// with the given argv. The trait stays object-safe so we can pass
/// `&dyn SidecarCommand` around without introducing a generic parameter
/// on every downstream type.
#[async_trait]
pub trait SidecarCommand: Send + Sync {
    async fn spawn(&self, args: Vec<String>) -> Result<SidecarChild>;

    /// Spawn the sidecar, wait for it to exit, and return an error if the
    /// exit status is non-zero. Default implementation is layered on top
    /// of [`SidecarCommand::spawn`] so existing implementors get the
    /// behaviour for free; override only if a backend needs custom
    /// waiting semantics (e.g. to stream progress while awaiting).
    async fn run(&self, args: Vec<String>) -> Result<()> {
        let mut child = self.spawn(args).await?;
        // Drop piped stdin so any FFmpeg pipeline that reads from stdin
        // sees EOF; callers that need to pump raw frames should use
        // `spawn` directly and drive the child themselves.
        drop(child.stdin);
        let mut stdout = child.stdout;
        let mut stderr = child.stderr;
        let stdout_task = tokio::spawn(async move {
            let mut sink = tokio::io::sink();
            let _ = tokio::io::copy(&mut stdout, &mut sink).await;
        });
        let stderr_task = tokio::spawn(async move { read_stderr_tail(&mut stderr).await });
        let status = child
            .child
            .wait()
            .await
            .map_err(|e| EncoderError::Io(format!("sidecar wait: {e}")))?;
        let _ = stdout_task.await;
        let stderr_tail = stderr_task.await.unwrap_or_default();
        if !status.success() {
            return Err(EncoderError::SpawnFailed(sidecar_exit_message(
                status,
                &stderr_tail,
            )));
        }
        Ok(())
    }
}

pub(crate) async fn read_stderr_tail<R>(reader: &mut R) -> String
where
    R: AsyncRead + Unpin,
{
    const MAX_TAIL_BYTES: usize = 4096;

    let mut tail = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                tail.extend_from_slice(&chunk[..n]);
                if tail.len() > MAX_TAIL_BYTES {
                    let drain = tail.len() - MAX_TAIL_BYTES;
                    tail.drain(..drain);
                }
            }
            Err(_) => break,
        }
    }

    String::from_utf8_lossy(&tail).trim().to_string()
}

pub(crate) fn sidecar_exit_message(status: std::process::ExitStatus, stderr_tail: &str) -> String {
    if stderr_tail.is_empty() {
        format!("sidecar exited with status {status}")
    } else {
        format!("sidecar exited with status {status}; stderr tail: {stderr_tail}")
    }
}

/// Piped stdio handles for a running FFmpeg process, plus the child.
pub struct SidecarChild {
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
    pub child: Child,
}

/// Concrete `SidecarCommand` that invokes a local `ffmpeg` binary via
/// `tokio::process::Command`. Used by tests (and also usable by the
/// Tauri host if it resolves the externalBin path itself and hands us
/// a `PathBuf`).
pub struct LocalFfmpegCommand {
    pub path: PathBuf,
}

impl LocalFfmpegCommand {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        LocalFfmpegCommand { path: path.into() }
    }
}

#[async_trait]
impl SidecarCommand for LocalFfmpegCommand {
    async fn spawn(&self, args: Vec<String>) -> Result<SidecarChild> {
        let mut cmd = tokio::process::Command::new(&self.path);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| EncoderError::SpawnFailed(format!("{}: {e}", self.path.display())))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| EncoderError::SpawnFailed("missing stdin handle".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| EncoderError::SpawnFailed("missing stdout handle".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| EncoderError::SpawnFailed("missing stderr handle".into()))?;

        Ok(SidecarChild {
            stdin,
            stdout,
            stderr,
            child,
        })
    }
}

/// Ergonomic wrapper around `SidecarChild` that owns the graceful-shutdown
/// state machine. The pipeline (`pipeline.rs`) holds one of these for
/// the duration of an encode.
pub struct FfmpegSidecar {
    inner: Option<SidecarChild>,
}

impl FfmpegSidecar {
    pub fn new(child: SidecarChild) -> Self {
        FfmpegSidecar { inner: Some(child) }
    }

    /// Take ownership of the handles for streaming. After this call the
    /// sidecar wrapper is empty and `graceful_shutdown` is a no-op.
    pub fn take(&mut self) -> Option<SidecarChild> {
        self.inner.take()
    }

    /// Wait for the child with a timeout. If the timeout elapses, kill
    /// the process and return `EncoderError::Timeout`.
    ///
    /// Callers should drop `stdin` BEFORE invoking this so FFmpeg sees
    /// EOF and writes the moov atom cleanly.
    pub async fn graceful_shutdown(
        mut self,
        timeout: Duration,
    ) -> Result<std::process::ExitStatus> {
        let Some(mut child) = self.inner.take().map(|c| c.child) else {
            return Err(EncoderError::Io("sidecar already taken".into()));
        };

        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(Ok(status)) => Ok(status),
            Ok(Err(e)) => Err(EncoderError::Io(format!("child wait: {e}"))),
            Err(_) => {
                // Timeout: SIGKILL. On tokio, `kill().await` sends SIGKILL
                // directly on Unix and TerminateProcess on Windows. We
                // don't bother with SIGTERM first — the 15s budget is
                // already the "nice" window.
                let _ = child.start_kill();
                let _ = child.wait().await;
                Err(EncoderError::Timeout(format!(
                    "ffmpeg exceeded {}ms shutdown budget",
                    timeout.as_millis()
                )))
            }
        }
    }
}

impl Drop for FfmpegSidecar {
    fn drop(&mut self) {
        if let Some(mut child) = self.inner.take() {
            // Last-resort: if the pipeline panics or is cancelled, don't
            // orphan the child. start_kill is non-blocking.
            let _ = child.child.start_kill();
        }
    }
}

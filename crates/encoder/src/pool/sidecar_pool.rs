//! FFmpeg sidecar pool: bounded concurrency + per-handle cancellation.
//!
//! The render queue actor (`queue::actor`) uses a `SidecarPool` to cap how
//! many FFmpeg children can run at once (N=2 default per CONTEXT.md
//! "Claude's discretion"). Acquiring a [`SidecarPermit`] blocks when the
//! pool is saturated.
//!
//! [`SidecarHandle`] wraps a single spawned child process and exposes
//! `cancel()`, which (a) fires a [`tokio_util::sync::CancellationToken`]
//! that the caller can observe and (b) sends `SIGTERM` (Unix) /
//! `TerminateProcess` (Windows) to the running child. Dropping a handle
//! also best-effort kills the child to avoid orphaned FFmpeg processes.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::{EncoderError, Result};
use crate::sidecar::SidecarCommand;

/// Tuning knobs for [`SidecarPool`].
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Hard cap on concurrent FFmpeg children. Default is 2 —
    /// per CONTEXT.md + T-02-29 DoS mitigation.
    pub max_concurrent: usize,
    /// Grace period after `cancel()` fires the cancellation token before
    /// we resort to `SIGKILL` / `TerminateProcess` via `start_kill`.
    pub cancel_grace: Duration,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            max_concurrent: 2,
            cancel_grace: Duration::from_secs(3),
        }
    }
}

/// Bounded concurrency pool for FFmpeg sidecars. Cloneable — the internal
/// [`Arc<Semaphore>`] makes clones share the same permit pool.
#[derive(Debug, Clone)]
pub struct SidecarPool {
    sem: Arc<Semaphore>,
    cfg: Arc<PoolConfig>,
}

impl SidecarPool {
    pub fn new(cfg: PoolConfig) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(cfg.max_concurrent)),
            cfg: Arc::new(cfg),
        }
    }

    pub fn max_concurrent(&self) -> usize {
        self.cfg.max_concurrent
    }

    pub fn cancel_grace(&self) -> Duration {
        self.cfg.cancel_grace
    }

    /// Block until a permit is available, then return one.
    pub async fn acquire(&self) -> Result<SidecarPermit> {
        let permit = self
            .sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| EncoderError::Io(format!("pool semaphore closed: {e}")))?;
        Ok(SidecarPermit { _permit: permit })
    }

    /// Number of permits currently available.
    pub fn available(&self) -> usize {
        self.sem.available_permits()
    }
}

/// RAII permit. Drop to return capacity to the pool.
pub struct SidecarPermit {
    _permit: OwnedSemaphorePermit,
}

/// A single spawned FFmpeg child, owned by the pool caller.
pub struct SidecarHandle {
    child: Option<Child>,
    cancel_token: CancellationToken,
    pid: Option<u32>,
}

impl SidecarHandle {
    /// Spawn a child via the caller-supplied [`SidecarCommand`]. The
    /// resulting handle owns the piped stdio; caller can access the
    /// [`CancellationToken`] via [`Self::cancel_token`] to observe cancel.
    pub async fn spawn(sidecar_cmd: &dyn SidecarCommand, args: Vec<String>) -> Result<Self> {
        let child = sidecar_cmd.spawn(args).await?;
        let pid = child.child.id();
        // The raw stdio handles are owned by the caller — they took them
        // out of SidecarChild before dropping it. We keep the Child so we
        // can observe exit and fire signals.
        Ok(Self {
            child: Some(child.child),
            cancel_token: CancellationToken::new(),
            pid,
        })
    }

    /// Spawn a child from a tokio `Command` without going through
    /// `SidecarCommand`. Used for tests and benchmark utilities that
    /// need to launch arbitrary commands (e.g. `sleep 10`).
    pub async fn spawn_cmd(mut cmd: Command) -> Result<Self> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = cmd
            .spawn()
            .map_err(|e| EncoderError::SpawnFailed(format!("spawn: {e}")))?;
        let pid = child.id();
        Ok(Self {
            child: Some(child),
            cancel_token: CancellationToken::new(),
            pid,
        })
    }

    /// Observe cancellation. Workers running alongside this handle can
    /// `select!` on `handle.cancel_token().cancelled()`.
    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Cancel the underlying child: fire the cancellation token, then
    /// send SIGTERM (Unix) / TerminateProcess-equivalent (Windows). If
    /// the child does not exit within `grace`, escalate to SIGKILL.
    pub async fn cancel(&mut self, grace: Duration) -> Result<()> {
        self.cancel_token.cancel();

        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };

        // Try to SIGTERM the child. On Unix we use nix syscalls via libc.
        // On Windows, tokio's `start_kill` sends TerminateProcess, which
        // is the only polite option available.
        #[cfg(unix)]
        {
            if let Some(pid) = self.pid {
                // SIGTERM = 15.
                // Safety: libc::kill is a plain syscall. An invalid pid
                // just returns an errno we ignore.
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                }
            }
        }
        #[cfg(windows)]
        {
            // No SIGTERM on Windows — TerminateProcess via start_kill is
            // equivalent to SIGKILL. We do it here; the grace timeout
            // below still applies but will usually complete immediately.
            let _ = child.start_kill();
        }

        match tokio::time::timeout(grace, child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(EncoderError::Io(format!("child wait: {e}"))),
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                Ok(())
            }
        }
    }

    /// Wait for the child to exit.
    pub async fn wait(mut self) -> Result<std::process::ExitStatus> {
        let mut child = self
            .child
            .take()
            .ok_or_else(|| EncoderError::Io("child already taken".into()))?;
        child
            .wait()
            .await
            .map_err(|e| EncoderError::Io(format!("child wait: {e}")))
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        // Best-effort: don't orphan children if the caller panics.
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[test]
    fn pool_default_size_2() {
        let cfg = PoolConfig::default();
        assert_eq!(cfg.max_concurrent, 2);
    }

    #[tokio::test]
    async fn pool_limits_concurrency() {
        let pool = SidecarPool::new(PoolConfig {
            max_concurrent: 2,
            cancel_grace: Duration::from_millis(100),
        });
        let _p1 = pool.acquire().await.unwrap();
        let _p2 = pool.acquire().await.unwrap();
        assert_eq!(pool.available(), 0);
        // A third acquire must block; prove by timing out.
        let r = timeout(Duration::from_millis(50), pool.acquire()).await;
        assert!(r.is_err(), "third acquire should have blocked");
    }

    #[tokio::test]
    async fn pool_release_unblocks_waiter() {
        let pool = SidecarPool::new(PoolConfig {
            max_concurrent: 1,
            cancel_grace: Duration::from_millis(100),
        });
        let p1 = pool.acquire().await.unwrap();
        let pool2 = pool.clone();
        let h = tokio::spawn(async move { pool2.acquire().await.map(|_| ()) });
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(p1);
        let r = timeout(Duration::from_millis(200), h).await;
        assert!(r.is_ok(), "release should have unblocked waiter");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pool_cancel_sends_sigterm() {
        // Spawn a long-lived child (sleep 10) and cancel.
        let mut cmd = Command::new("sleep");
        cmd.arg("10");
        let mut handle = SidecarHandle::spawn_cmd(cmd).await.unwrap();
        let tok = handle.cancel_token();
        let before = std::time::Instant::now();
        handle.cancel(Duration::from_secs(2)).await.unwrap();
        let elapsed = before.elapsed();
        assert!(tok.is_cancelled(), "token should be cancelled");
        assert!(
            elapsed < Duration::from_secs(3),
            "cancel should have been fast; was {elapsed:?}"
        );
    }
}

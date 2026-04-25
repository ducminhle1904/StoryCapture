// Logging bridge — `tracing` ↔ `tauri-plugin-log` (D-30).
//
// `tracing` owns the canonical log file on disk via `SizeRollingWriter`,
// configured from the Settings UI (`max_file_size_bytes`, `max_files`).
// `tauri-plugin-log` separately exposes a `log:` IPC for the renderer.
//
// On-disk layout: `storycapture.log` (live), `storycapture.1.log` (newest
// archive) … `storycapture.{N-1}.log` (oldest, pruned on next rotation).
// Every event line is prefixed with `session=<uuid>` so a single file
// holding multiple restarts can be sliced by run; `current_session_id()`
// surfaces the value to the renderer for bug reports.
//
// Telemetry-off (D-30): logs are LOCAL ONLY. Nothing here touches the network.

use std::{
    fmt,
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::Context;
use tracing::{Event, Subscriber};
use tracing_subscriber::{
    fmt::{
        format::{DefaultFields, Format, FormatEvent, FormatFields, Writer},
        FmtContext, MakeWriter,
    },
    layer::SubscriberExt,
    registry::LookupSpan,
    util::SubscriberInitExt,
    EnvFilter,
};
use uuid::Uuid;

use crate::commands::app_settings::LogConfig;

const LIVE_FILE_NAME: &str = "storycapture.log";

static SESSION_ID: OnceLock<String> = OnceLock::new();

/// Returns the current process's session id (a v4 UUID set during
/// `init`). Falls back to `"unknown"` if the logger has not been
/// initialised yet (test contexts, very early panics).
pub fn current_session_id() -> &'static str {
    SESSION_ID.get().map(String::as_str).unwrap_or("unknown")
}

/// Initialize tracing-subscriber with:
///  * an env-filter (default `storycapture=info,warn`)
///  * a stdout layer in debug builds
///  * a size-based rolling-file layer in `config`-resolved log dir
///  * a session-prefixing event formatter so every line carries the run id
///  * `RUST_BACKTRACE=1` for richer panic backtraces (only if unset)
pub fn init(default_log_dir: &Path, config: &LogConfig) -> anyhow::Result<()> {
    if std::env::var_os("RUST_BACKTRACE").is_none() {
        // Force-capture backtraces by default so panic_hook.rs always has
        // something useful in the log file. Users can opt out by setting
        // RUST_BACKTRACE=0 explicitly in their shell before launch.
        // Safety: only mutating one process-wide variable, before any
        // other thread could read it.
        unsafe {
            std::env::set_var("RUST_BACKTRACE", "1");
        }
    }

    let log_dir = config.resolve_dir(default_log_dir);
    std::fs::create_dir_all(&log_dir)
        .with_context(|| format!("creating log dir {}", log_dir.display()))?;

    let session_id = Uuid::new_v4().to_string();
    SESSION_ID.set(session_id.clone()).ok();

    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("storycapture=info,warn"))
        .context("building EnvFilter")?;

    let writer = SizeRollingWriter::new(
        log_dir.clone(),
        LIVE_FILE_NAME.to_string(),
        config.max_file_size_bytes,
        config.max_files,
    )
    .context("opening rolling log file")?;

    let inner_format = Format::default()
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(true)
        .with_file(true)
        .with_line_number(true);

    let file_event_format = SessionPrefixFormat {
        session_id: session_id.clone(),
        inner: inner_format,
    };

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .event_format(file_event_format)
        .fmt_fields(DefaultFields::new());

    let registry = tracing_subscriber::registry().with(filter).with(file_layer);

    #[cfg(debug_assertions)]
    {
        let stdout_format = Format::default()
            .with_ansi(true)
            .with_target(false)
            .with_file(true)
            .with_line_number(true);
        let stdout_event_format = SessionPrefixFormat {
            session_id: session_id.clone(),
            inner: stdout_format,
        };
        let stdout_layer = tracing_subscriber::fmt::layer()
            .with_writer(std::io::stdout)
            .event_format(stdout_event_format)
            .fmt_fields(DefaultFields::new());
        registry.with(stdout_layer).try_init()?;
    }

    #[cfg(not(debug_assertions))]
    {
        registry.try_init()?;
    }

    // Bridge log -> tracing (chromiumoxide, hyper, etc. use `log`).
    // Ignore errors: a logger may already be installed (tauri-plugin-log
    // claims the global `log` slot, in which case third-party `log`
    // events flow through it instead — they still land in the same dir).
    let _ = tracing_log::LogTracer::init();

    let banner = format!(
        "===== storycapture session start | session={} | pid={} =====",
        session_id,
        std::process::id()
    );
    tracing::info!(target: "storycapture::boot", "{banner}");
    tracing::info!(
        target: "storycapture::boot",
        session_id = %session_id,
        log_dir = %log_dir.display(),
        max_file_size_bytes = config.max_file_size_bytes,
        max_files = config.max_files,
        version = env!("CARGO_PKG_VERSION"),
        "tracing initialised"
    );
    Ok(())
}

/// Wraps a default tracing event formatter so every line is prefixed with
/// `session=<uuid>`. Lets a single log file containing multiple app runs
/// be sliced by session id without altering the inner formatting.
struct SessionPrefixFormat<F> {
    session_id: String,
    inner: F,
}

impl<S, N, F> FormatEvent<S, N> for SessionPrefixFormat<F>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
    F: FormatEvent<S, N>,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        write!(writer, "session={} ", self.session_id)?;
        self.inner.format_event(ctx, writer, event)
    }
}

/// Size-based rotating file writer.
///
/// Cheap to clone (`Arc<Mutex<…>>`). Writes are line-flushed via the
/// surrounding `tracing-subscriber` formatter; on each `write`, we check
/// whether the current file would exceed `max_file_size_bytes` and rotate
/// before appending if so.
#[derive(Clone)]
pub struct SizeRollingWriter {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    log_dir: PathBuf,
    base_name: String,
    max_file_size_bytes: u64,
    max_files: usize,
    /// `None` only for the brief moment inside `rotate` while the previous
    /// file handle is being dropped before the rename (Windows requires
    /// the file to be closed before it can be renamed).
    file: Option<File>,
    current_size: u64,
}

impl SizeRollingWriter {
    pub fn new(
        log_dir: PathBuf,
        base_name: String,
        max_file_size_bytes: u64,
        max_files: usize,
    ) -> io::Result<Self> {
        std::fs::create_dir_all(&log_dir)?;
        let live_path = log_dir.join(&base_name);
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&live_path)?;
        let current_size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                log_dir,
                base_name,
                max_file_size_bytes: max_file_size_bytes.max(1),
                max_files: max_files.max(1),
                file: Some(file),
                current_size,
            })),
        })
    }
}

impl Inner {
    fn live_path(&self) -> PathBuf {
        self.log_dir.join(&self.base_name)
    }

    /// `storycapture.{n}.log` for n >= 1; the live file for n == 0.
    fn archive_path(&self, n: usize) -> PathBuf {
        if n == 0 {
            return self.live_path();
        }
        let path = Path::new(&self.base_name);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&self.base_name);
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("log");
        self.log_dir.join(format!("{stem}.{n}.{ext}"))
    }

    /// Defensive: prune any archive index beyond `max_files - 1`.
    /// Handles the case where the user shrank `max_files` between runs.
    fn prune_overflow_archives(&self) {
        let max_archives = self.max_files.saturating_sub(1);
        // Cap the scan at `max_files + 1024` so a corrupted directory
        // can't loop indefinitely; 1024 stale archives is already absurd.
        for n in (max_archives + 1)..=(self.max_files + 1024) {
            let p = self.archive_path(n);
            if !p.exists() {
                break;
            }
            let _ = std::fs::remove_file(&p);
        }
    }

    /// Rotate: close current → shift archives → open fresh live file.
    fn rotate(&mut self) -> io::Result<()> {
        // Drop the live file BEFORE renaming — Windows holds an exclusive
        // lock until the handle is closed.
        self.file.take();

        self.prune_overflow_archives();

        let max_archives = self.max_files.saturating_sub(1);
        if max_archives == 0 {
            if let Err(e) = std::fs::remove_file(self.live_path()) {
                if e.kind() != io::ErrorKind::NotFound {
                    eprintln!(
                        "[storycapture] log rotation: failed to truncate live file {}: {}",
                        self.live_path().display(),
                        e
                    );
                }
            }
        } else {
            // Shift archives down: oldest is dropped, then N-1→N, …, 1→2,
            // finally live→1.
            let _ = std::fs::remove_file(self.archive_path(max_archives));
            for i in (1..max_archives).rev() {
                let _ = std::fs::rename(self.archive_path(i), self.archive_path(i + 1));
            }
            let _ = std::fs::rename(self.live_path(), self.archive_path(1));
        }

        let live = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.live_path())?;
        self.file = Some(live);
        self.current_size = 0;
        Ok(())
    }

    fn would_exceed(&self, buf_len: usize) -> bool {
        // Skip rotation when the file is empty — a single oversized event
        // shouldn't trigger an immediate rotate-on-first-write.
        self.current_size > 0
            && self
                .current_size
                .saturating_add(buf_len as u64)
                > self.max_file_size_bytes
    }
}

impl Write for Inner {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.would_exceed(buf.len()) {
            // Rotation failure must not silently drop user events: surface
            // it on stderr (the panic chain + `cargo run` console see it)
            // and keep appending to the existing file.
            if let Err(e) = self.rotate() {
                eprintln!(
                    "[storycapture] log rotation FAILED at {}: {} (continuing on existing file)",
                    self.live_path().display(),
                    e
                );
            }
        }
        let writer = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log writer is mid-rotation"))?;
        let n = writer.write(buf)?;
        self.current_size = self.current_size.saturating_add(n as u64);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(w) => w.flush(),
            None => Ok(()),
        }
    }
}

/// Guard handed to `tracing-subscriber` for each emitted event.
pub struct LockedRollingWriter<'a> {
    guard: std::sync::MutexGuard<'a, Inner>,
}

impl<'a> Write for LockedRollingWriter<'a> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.guard.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.guard.flush()
    }
}

impl<'a> MakeWriter<'a> for SizeRollingWriter {
    type Writer = LockedRollingWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        LockedRollingWriter {
            // Recover from a poisoned lock so a panic in another thread
            // doesn't silently kill logging.
            guard: self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn read_file(p: &Path) -> String {
        let mut s = String::new();
        File::open(p).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    #[test]
    fn rotates_on_size_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let writer =
            SizeRollingWriter::new(dir.path().to_path_buf(), "test.log".into(), 100, 3).unwrap();

        // Write enough to trigger ~3 rotations: each line ~30 bytes, so
        // 4 * 30 = 120 bytes > 100 forces a rotate; repeat to push older
        // archives down the stack.
        for i in 0..16 {
            let mut w = writer.make_writer();
            writeln!(w, "line-{i:03} payload-pad-pad-pad").unwrap();
            w.flush().unwrap();
        }

        // Live file always exists.
        assert!(dir.path().join("test.log").exists());
        // At most max_files-1 archives.
        let archive_1 = dir.path().join("test.1.log");
        let archive_2 = dir.path().join("test.2.log");
        let archive_3 = dir.path().join("test.3.log");
        assert!(archive_1.exists(), "archive 1 should exist");
        assert!(archive_2.exists(), "archive 2 should exist");
        assert!(
            !archive_3.exists(),
            "archive 3 should NOT exist (max_files=3 caps at .2.log)"
        );

        // Live should be < threshold (or just over after one write).
        let live = read_file(&dir.path().join("test.log"));
        assert!(!live.is_empty());
    }

    #[test]
    fn no_rotation_when_max_files_is_one() {
        let dir = tempfile::tempdir().unwrap();
        let writer =
            SizeRollingWriter::new(dir.path().to_path_buf(), "test.log".into(), 50, 1).unwrap();

        for i in 0..10 {
            let mut w = writer.make_writer();
            writeln!(w, "line-{i:03} pad").unwrap();
            w.flush().unwrap();
        }

        // Only the live file is kept.
        assert!(dir.path().join("test.log").exists());
        assert!(!dir.path().join("test.1.log").exists());
    }
}

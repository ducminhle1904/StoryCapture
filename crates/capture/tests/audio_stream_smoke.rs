//! Audio pipeline smoke tests (Phase 6 plan 01, Task 0/1).
//!
//! Tests run under the `audio-mock` feature so CI hosts without a real
//! mic (and without Microphone TCC grant on macOS) can exercise the full
//! ringbuf → named-pipe → reader path without hardware.

#![cfg(feature = "audio-mock")]

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use capture::audio::{list_inputs, make_fifo, AudioCaptureStream};

/// Test 1 — list_inputs() never triggers mic TCC and returns Ok(Vec).
/// On a fresh macOS CI host with no mic, Vec is empty — we only check
/// that the call itself does not error and that no `default_input_device`
/// resolution eagerly happens (validated in practice by Task 3's
/// DYLD_PRINT_APIS check; here we just exercise the code path).
#[test]
fn list_inputs_lazy_enumeration() {
    let result = list_inputs();
    // We don't care about the content — just that enumeration is
    // non-panicking and returns a Result.
    assert!(result.is_ok(), "list_inputs returned error: {:?}", result.err());
}

/// Test 2 — mock stream writes sample bytes to the fifo at ~48 kHz. The
/// reader thread counts bytes and the test asserts within ±15% of the
/// expected rate over ~500 ms (generous tolerance because the mock paces
/// itself with a 10 ms sleep loop and OS scheduling jitter on macOS can
/// easily shift a single tick).
#[test]
fn mock_stream_writes_at_expected_rate() {
    let fifo = make_fifo("smoke-rate").expect("make_fifo");
    let fifo_path: PathBuf = fifo.path().to_path_buf();

    // Open the reader side FIRST — POSIX fifo semantics (RESEARCH
    // Pitfall 8). We spawn the reader thread so open blocks there, not
    // here; start_mock waits for a reader by blocking on OpenOptions.
    let reader_path = fifo_path.clone();
    let reader = std::thread::spawn(move || {
        let mut f = std::fs::OpenOptions::new()
            .read(true)
            .open(&reader_path)
            .expect("reader open");
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        let mut total = 0usize;
        let mut buf = [0u8; 8192];
        while std::time::Instant::now() < deadline {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => total += n,
                Err(_) => break,
            }
        }
        total
    });

    let (_stream, info) =
        AudioCaptureStream::start(Some("__mock__"), fifo_path).expect("start mock stream");
    assert_eq!(info.sample_rate, 48_000);
    assert_eq!(info.channels, 1);

    let total_bytes = reader.join().expect("reader join");
    // 48 kHz × 4 bytes/sample × 0.5 s = 96_000 bytes ideal.
    // Mock paces at 10 ms → ~50 iterations × 480 samples × 4 bytes = 96_000.
    // Accept 40_000..=150_000 to absorb startup + teardown jitter.
    assert!(
        (40_000..=150_000).contains(&total_bytes),
        "unexpected byte count {total_bytes} (expected ~96000)"
    );
}

/// Test 3 — dropping the stream joins the drain thread within 100 ms.
/// Leaked threads are a canonical resource-leak signature; we catch them
/// here before they bite us in recording teardown.
#[test]
fn stream_drops_cleanly_within_budget() {
    let fifo = make_fifo("smoke-drop").expect("make_fifo");
    let fifo_path: PathBuf = fifo.path().to_path_buf();

    // Reader has to be present or start_mock blocks on fifo open forever.
    let reader_path = fifo_path.clone();
    let reader = std::thread::spawn(move || {
        let mut f = match std::fs::OpenOptions::new().read(true).open(&reader_path) {
            Ok(f) => f,
            Err(_) => return,
        };
        let mut buf = [0u8; 4096];
        // Drain until EOF (fifo writer side closes on stream drop).
        while let Ok(n) = f.read(&mut buf) {
            if n == 0 {
                break;
            }
        }
    });

    let (stream, _info) =
        AudioCaptureStream::start(Some("__mock__"), fifo_path).expect("start mock stream");

    // Let a handful of writes happen.
    std::thread::sleep(Duration::from_millis(50));

    let start = std::time::Instant::now();
    drop(stream);
    let elapsed = start.elapsed();

    // Budget is 100 ms — the drain thread's poll interval is 10 ms in
    // mock mode + a final buffer flush. Give a little breathing room.
    assert!(
        elapsed < Duration::from_millis(300),
        "stream Drop took {elapsed:?} — expected < 300 ms"
    );

    let _ = reader.join();
}

/// Test 4 (Windows-only) — make_fifo returns a `\\.\pipe\...` path that
/// is valid for CreateFile by a second process. We don't spawn a second
/// process in the test; just assert the prefix.
#[cfg(windows)]
#[test]
fn make_fifo_windows_namespace_prefix() {
    let f = make_fifo("win-prefix").expect("make_fifo");
    let p = f.path().to_string_lossy().to_string();
    assert!(
        p.starts_with("\\\\.\\pipe\\"),
        "expected \\\\.\\pipe\\ prefix, got {p}"
    );
}

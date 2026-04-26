//! Window enumeration integration tests.
//!
//! Gated behind the `real-capture` feature since they call `SCShareableContent::get`
//! which requires a real macOS host with Screen Recording granted.
//! Tests are `#[ignore]`'d so `cargo test -p capture --features real-capture --no-run`
//! compiles them in CI but they only run when explicitly invoked.

#![cfg(all(target_os = "macos", feature = "real-capture"))]

use capture::macos::window::list_windows;

/// `list_windows()` must exclude windows owned by the test process itself.
#[test]
#[ignore = "requires Screen Recording TCC grant — run manually"]
fn list_windows_excludes_self() {
    let me = std::process::id() as i32;
    let infos = list_windows().expect("list_windows failed");
    assert!(
        !infos.iter().any(|w| w.pid == me),
        "list_windows returned our own process's windows (pid={me})"
    );
}

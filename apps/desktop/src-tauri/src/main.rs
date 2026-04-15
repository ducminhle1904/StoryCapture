// StoryCapture desktop entry point — Phase 1 plan 01-03.
//
// Thin shim: all wiring lives in the library crate so it can be exercised by
// integration tests + the future `specta-emit` binary without re-running the
// Tauri runtime.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    storycapture::run();
}

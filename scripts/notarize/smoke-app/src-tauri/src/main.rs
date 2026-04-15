// Phase 1 plan 01-02 — throwaway notarization smoke app.
// Purpose: a real Tauri v2 binary that bundles the static FFmpeg sidecar so
// the sign + notarize + staple pipeline is exercised end-to-end on every PR.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error running smoke-notarize tauri app");
}

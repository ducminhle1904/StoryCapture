// Tauri host build script — Phase 1 plan 01-03.
//
// Runs the standard `tauri-build` codegen plus, in debug builds, emits the
// tauri-specta TS bindings to `packages/shared-types/src/ipc.ts` so the
// frontend (Plan 01-03b + UI plans) always has fresh, typed IPC stubs
// without a separate codegen step.
//
// Production / release builds skip the specta emit because the generated
// file is committed to the repo and CI verifies it stays in sync via
// `cargo run --bin specta-emit` (Plan 10).
//
// Backlog #9: also emits `$OUT_DIR/browser_presets.rs` from the canonical
// `packages/shared-types/browser-presets.json` so Rust and TS share a
// single source of truth for browser preset metadata (ids, window-title
// hints, exec-path basename fragments).

use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();

    // Re-run if the IPC surface changes.
    println!("cargo:rerun-if-changed=src/ipc_spec.rs");
    println!("cargo:rerun-if-changed=src/commands/system.rs");
    println!("cargo:rerun-if-changed=src/error.rs");

    emit_browser_presets();
}

/// Backlog #9 — codegen `browser_presets.rs` from the canonical
/// `packages/shared-types/browser-presets.json`. JSON order MATTERS
/// (specific-first: `chrome-canary` before `chrome`, `msedge-canary`
/// before `msedge`) and is preserved verbatim into the emitted slice.
fn emit_browser_presets() {
    // CARGO_MANIFEST_DIR = apps/desktop/src-tauri → repo root is ../../..
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let json_path = manifest
        .join("../../../packages/shared-types/browser-presets.json")
        .canonicalize()
        .expect("browser-presets.json must exist at packages/shared-types/");
    println!("cargo:rerun-if-changed={}", json_path.display());

    #[derive(serde::Deserialize)]
    struct File {
        presets: Vec<Preset>,
    }
    #[derive(serde::Deserialize)]
    struct Preset {
        id: String,
        title: String,
        basenames: Vec<String>,
    }

    let raw = fs::read_to_string(&json_path).expect("read browser-presets.json");
    let file: File = serde_json::from_str(&raw).expect("browser-presets.json is malformed");

    let mut out = String::from(
        "// @generated from packages/shared-types/browser-presets.json — do not edit.\n\
         pub struct PresetEntry {\n\
         \x20   pub id: &'static str,\n\
         \x20   pub title: &'static str,\n\
         \x20   pub basenames: &'static [&'static str],\n\
         }\n\n\
         pub static BROWSER_PRESETS: &[PresetEntry] = &[\n",
    );
    for p in &file.presets {
        out.push_str(&format!(
            "    PresetEntry {{ id: {:?}, title: {:?}, basenames: &[",
            p.id, p.title
        ));
        for b in &p.basenames {
            out.push_str(&format!("{:?}, ", b.to_lowercase()));
        }
        out.push_str("] },\n");
    }
    out.push_str("];\n");

    let dest = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR set by cargo"))
        .join("browser_presets.rs");
    fs::write(&dest, out).expect("write browser_presets.rs");
}

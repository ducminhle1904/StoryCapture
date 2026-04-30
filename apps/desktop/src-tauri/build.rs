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

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() {
    tauri_build::build();

    // Re-run if the IPC surface changes.
    println!("cargo:rerun-if-changed=src/ipc_spec.rs");
    println!("cargo:rerun-if-changed=src/commands/system.rs");
    println!("cargo:rerun-if-changed=src/error.rs");

    emit_native_build_info();
    emit_browser_presets();
}

fn emit_native_build_info() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| manifest.clone());

    emit_git_rerun_hints(&repo_root);

    let git_sha = command_output(&repo_root, "git", &["rev-parse", "--short=12", "HEAD"])
        .unwrap_or_else(|| "unknown".to_string());
    let git_dirty = command_output(&repo_root, "git", &["status", "--porcelain"])
        .map(|status| {
            if status.trim().is_empty() {
                "false"
            } else {
                "true"
            }
        })
        .unwrap_or("unknown")
        .to_string();
    let build_unix_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    println!("cargo:rustc-env=STORYCAPTURE_BUILD_GIT_SHA={git_sha}");
    println!("cargo:rustc-env=STORYCAPTURE_BUILD_GIT_DIRTY={git_dirty}");
    println!("cargo:rustc-env=STORYCAPTURE_BUILD_UNIX_SECS={build_unix_secs}");
    println!(
        "cargo:rustc-env=STORYCAPTURE_BUILD_PROFILE={}",
        env::var("PROFILE").unwrap_or_else(|_| "unknown".to_string())
    );
}

fn emit_git_rerun_hints(repo_root: &Path) {
    let Some(git_dir) = resolve_git_dir(repo_root) else {
        return;
    };

    let head_path = git_dir.join("HEAD");
    println!("cargo:rerun-if-changed={}", head_path.display());

    if let Ok(head) = fs::read_to_string(&head_path) {
        if let Some(reference) = head.trim().strip_prefix("ref: ") {
            println!(
                "cargo:rerun-if-changed={}",
                git_dir.join(reference).display()
            );
        }
    }

    println!(
        "cargo:rerun-if-changed={}",
        git_dir.join("packed-refs").display()
    );
}

fn resolve_git_dir(repo_root: &Path) -> Option<PathBuf> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }

    let git_file = fs::read_to_string(&dot_git).ok()?;
    let path = git_file.trim().strip_prefix("gitdir: ")?;
    let path = PathBuf::from(path);
    Some(if path.is_absolute() {
        path
    } else {
        repo_root.join(path)
    })
}

fn command_output(cwd: &Path, program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    Some(stdout.trim().to_string())
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

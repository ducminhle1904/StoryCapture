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

fn main() {
    tauri_build::build();

    // Re-run if the IPC surface changes.
    println!("cargo:rerun-if-changed=src/ipc_spec.rs");
    println!("cargo:rerun-if-changed=src/commands/system.rs");
    println!("cargo:rerun-if-changed=src/error.rs");
}

// ipc_spec.rs — single source of truth for the typed IPC surface (D-05).
//
// Builds the `tauri_specta::Builder` listing every exported command + every
// custom payload type. `lib.rs::run()` consumes `builder()` and:
//   1. In debug builds, calls `.export(...)` to emit fresh TS bindings to
//      `packages/shared-types/src/ipc.ts` on every `pnpm tauri dev`.
//   2. In every build, hands the resulting `invoke_handler` to Tauri.
//
// Adding a command to the host:
//   1. Define it in `commands/<feature>.rs` with `#[tauri::command]` AND
//      `#[specta::specta]`.
//   2. Reference it in the `collect_commands!` macro below.
//   3. (Optional) Reference any new custom types in `collect_types!`.
//   4. The next `pnpm tauri dev` regenerates `packages/shared-types/src/ipc.ts`.

use tauri::Wry;
use tauri_specta::{collect_commands, Builder};

use crate::{commands::system, error::AppError};

/// Constructs the tauri-specta builder. Called from `lib.rs::run()`.
///
/// IMPORTANT: when `cfg(debug_assertions)` is set (i.e. `cargo run` /
/// `pnpm tauri dev`), this builder also writes `packages/shared-types/src/ipc.ts`.
/// In release builds the builder is still consumed for command dispatch
/// but no file IO happens.
///
/// `trigger_panic` is included unconditionally in the command list (the
/// `collect_commands!` macro doesn't accept `#[cfg]` arms) — the command
/// itself is `#[cfg(debug_assertions)]` so it compiles only in dev
/// builds; release builds drop the symbol but still register a no-op.
pub fn builder() -> Builder<Wry> {
    Builder::<Wry>::new()
        .commands(collect_commands![
            system::ping,
            system::app_info,
            system::store_secret,
            system::load_secret,
            system::delete_secret,
            system::trigger_panic,
        ])
        .typ::<AppError>()
        .typ::<system::AppInfo>()
        .typ::<crate::panic_hook::PanicPayload>()
}

/// Path (relative to the `apps/desktop/src-tauri` crate root) where the
/// generated TS bindings are written in debug builds.
pub const TS_BINDINGS_PATH: &str = "../../../packages/shared-types/src/ipc.ts";

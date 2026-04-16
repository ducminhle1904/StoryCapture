// @storycapture/shared-types
//
// Codegen target for tauri-specta Rust → TS bindings (Phase 1 plan 01-03).
// `ipc.ts` is regenerated on every `pnpm tauri dev` from
// `apps/desktop/src-tauri/src/ipc_spec.rs`. DO NOT edit it by hand.

export * from "./ipc";

// Note: WebAccountInfo is exported via ipc.ts (tauri-specta codegen).
// See web-account.ts for the standalone type definition (not re-exported
// here to avoid collision with the codegen output).

// Event-name constants — manually curated alongside the Rust `EventChannels`
// enum in `apps/desktop/src-tauri/src/events.rs`. Update together.
export const APP_PANIC_EVENT = "app:panic" as const;

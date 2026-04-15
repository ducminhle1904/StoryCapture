// @storycapture/shared-types
//
// Codegen target for tauri-specta Rust → TS bindings (Phase 1 plan 01-03).
// `ipc.ts` is regenerated on every `pnpm tauri dev` from
// `apps/desktop/src-tauri/src/ipc_spec.rs`. DO NOT edit it by hand.

export * from "./ipc";

// Event-name constants — manually curated alongside the Rust `EventChannels`
// enum in `apps/desktop/src-tauri/src/events.rs`. Update together.
export const APP_PANIC_EVENT = "app:panic" as const;

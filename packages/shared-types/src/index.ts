// @storycapture/shared-types
// Shared TS exports for desktop IPC and companion types.
// `ipc.ts` is generated from `ipc_spec.rs`; do not edit it by hand.

export * from "./ipc";
export * from "./browser-presets";

// WebAccountInfo stays in web-account.ts to avoid colliding with generated types.

// Keep event names in sync with Rust `EventChannels`.
export const APP_PANIC_EVENT = "app:panic" as const;

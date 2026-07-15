// @storycapture/shared-types
// Shared TS exports for desktop IPC and companion types.
// `ipc.ts` is the checked-in host IPC compatibility surface.

export * from "./browser-presets";
export * from "./export-composition";
export * from "./ipc";

// WebAccountInfo stays in web-account.ts to avoid colliding with IPC types.

// Keep event names in sync with the Electron host event bridge.
export const APP_PANIC_EVENT = "app:panic" as const;

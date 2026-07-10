/**
 * Typed wrappers around Tauri `invoke` consuming the auto-generated
 * `@storycapture/shared-types/ipc` types from Plan 03a. Downstream plans
 * (P09 onwards) extend this module with domain commands.
 */

import { APP_PANIC_EVENT, type AppInfo, type PanicPayload } from "@storycapture/shared-types";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const ping = (): Promise<string> => invoke<string>("ping");

export const appInfo = (): Promise<AppInfo> => invoke<AppInfo>("app_info");

export const storeSecret = (service: string, key: string, value: string): Promise<void> =>
  invoke<void>("store_secret", { service, key, value });

export const loadSecret = (service: string, key: string): Promise<string> =>
  invoke<string>("load_secret", { service, key });

export const triggerPanic = (): Promise<void> => invoke<void>("trigger_panic");

/**
 * Subscribe to the host's panic event. Returns an unlisten function.
 * The host emits `app:panic` from its `std::panic::set_hook` (Plan 03a).
 */
export const onPanic = (cb: (payload: PanicPayload) => void): Promise<UnlistenFn> =>
  listen<PanicPayload>(APP_PANIC_EVENT, (event) => cb(event.payload));

export type { AppInfo, PanicPayload } from "@storycapture/shared-types";

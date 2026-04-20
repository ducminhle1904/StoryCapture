/**
 * Plugin-store wrapper — Phase 13's first production use of
 * `@tauri-apps/plugin-store`. Owns the store filename + key constants;
 * consumers use `getStore()`.
 */
import { Store } from "@tauri-apps/plugin-store";

export const STORE_FILE = "output-prefs.json";
export const STORE_KEY = "output-prefs.v1";
export const LATEST_VERSION = 1 as const;

let cached: Promise<Store> | null = null;

export function getStore(): Promise<Store> {
  if (!cached) cached = Store.load(STORE_FILE);
  return cached;
}

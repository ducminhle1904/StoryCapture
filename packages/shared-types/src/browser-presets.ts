/**
 * Canonical browser-preset table (backlog #9).
 *
 * Source of truth: `packages/shared-types/browser-presets.json`. This module
 * is the TypeScript surface; the Rust side (apps/desktop/src-tauri) reads
 * the same JSON at build time via `build.rs` codegen into a `&[PresetEntry]`
 * const. Do not fork the data — edit the JSON.
 *
 * Iteration order in the JSON is specific-first: Chrome Canary/Beta/Dev
 * come before Chrome, Edge Canary/Beta/Dev before Edge. Callers relying on
 * basename substring matching must honour this order.
 */
import presets from "../browser-presets.json";

export interface BrowserPreset {
  readonly id: string;
  readonly title: string;
  readonly basenames: readonly string[];
}

export const BROWSER_PRESETS: readonly BrowserPreset[] =
  presets.presets as readonly BrowserPreset[];

/**
 * Lowercase preset ids (e.g. "chromium", "chrome-canary", "msedge-canary").
 * Replaces the hand-maintained `CHROMIUM_PRESETS` set in
 * features/settings/browser-presets.ts.
 */
export const CHROMIUM_PRESET_IDS: ReadonlySet<string> = new Set(
  BROWSER_PRESETS.map((p) => p.id),
);

/**
 * Window-title substring for a preset id. Returns null for unknown ids;
 * callers should fall back to pid-only window matching (D-15).
 */
export function titleHintForPreset(id: string): string | null {
  const lower = id.toLowerCase();
  return BROWSER_PRESETS.find((p) => p.id === lower)?.title ?? null;
}

/**
 * Lowercase basename fragments for a preset id (used by exec-path heuristics
 * to re-derive the preset when the caller only has an executable path).
 */
export function basenameFragmentsForPreset(id: string): readonly string[] {
  const lower = id.toLowerCase();
  return BROWSER_PRESETS.find((p) => p.id === lower)?.basenames ?? [];
}

/**
 * True iff the id is a known Chromium-family preset. Bundled Playwright
 * Chromium (null / empty label) is treated as Chromium-family by the
 * higher-level `isChromiumFamily` wrapper — this predicate is strict.
 */
export function isChromiumFamilyPreset(id: string): boolean {
  return CHROMIUM_PRESET_IDS.has(id.toLowerCase());
}

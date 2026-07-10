/**
 * Browser-preset helpers. Single source of truth for "is this preset
 * Chromium-family?" — the flag that gates chrome-hiding (`--app=`)
 * availability.
 *
 * Preset label strings intentionally stay loose (case-insensitive match)
 * so a future Settings UI can accept user-typed values without breaking
 * the gating logic.
 *
 * The preset id set and basename fragments are sourced from
 * `@storycapture/shared-types` (canonical
 * `packages/shared-types/browser-presets.json`). This module is a thin adapter so `isChromiumFamily` and
 * `CHROMIUM_PRESETS` callers (e.g. ChromeHidingToggle.tsx) do not need
 * to change their imports.
 */
import { BROWSER_PRESETS, CHROMIUM_PRESET_IDS } from "@storycapture/shared-types";

/**
 * Set of Chromium-family preset tokens (lowercase). Anything outside
 * this set is treated as non-Chromium — the ChromeHidingToggle is
 * disabled so users aren't surprised when Safari/Firefox silently
 * ignore the `--app=` launch flag.
 *
 * Back-compat re-export of the SSOT set from shared-types. All current
 * browser presets are Chromium-family; if we ever add a non-Chromium
 * preset, the shared-types layer will need a dedicated `family` field.
 */
export const CHROMIUM_PRESETS: ReadonlySet<string> = CHROMIUM_PRESET_IDS;

/**
 * Map a BrowserRow preset label (or executable path fragment) to the
 * Chromium-family flag. Matches on lowercase label, then on filename
 * basename for path inputs. Returns true for the bundled Playwright
 * Chromium (`null` label / empty path).
 */
export function isChromiumFamily(label: string | null | undefined): boolean {
  // No explicit preset → bundled Playwright Chromium.
  if (!label) return true;
  const lower = label.toLowerCase();
  if (CHROMIUM_PRESETS.has(lower)) return true;
  // Exec-path heuristic: look at the filename basename (macOS app
  // wrapper pattern: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
  // All shipped presets today are Chromium-family, so any basename-fragment
  // match is a Chromium-family match.
  const basename = lower.split(/[/\\]/).pop() ?? "";
  if (!basename) return false;
  return BROWSER_PRESETS.some((p) => p.basenames.some((b) => basename.includes(b)));
}

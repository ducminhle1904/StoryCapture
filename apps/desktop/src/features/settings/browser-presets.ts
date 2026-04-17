/**
 * Browser-preset helpers — Plan 06-02.
 *
 * Single source of truth for "is this preset Chromium-family?" — the
 * flag that gates chrome-hiding (`--app=`) availability per D-11.
 *
 * Preset label strings intentionally stay loose (case-insensitive match)
 * so a future Settings UI can accept user-typed values without breaking
 * the gating logic.
 */

/**
 * Set of Chromium-family preset tokens (lowercase). Anything outside
 * this set is treated as non-Chromium — the ChromeHidingToggle is
 * disabled so users aren't surprised when Safari/Firefox silently
 * ignore the `--app=` launch flag.
 */
export const CHROMIUM_PRESETS: ReadonlySet<string> = new Set([
  "chromium",
  "chrome",
  "chrome-beta",
  "chrome-canary",
  "chrome-dev",
  "msedge",
  "msedge-beta",
  "msedge-canary",
  "msedge-dev",
  "brave",
  "arc",
]);

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
  const basename = lower.split(/[\/\\]/).pop() ?? "";
  if (basename.includes("chrome")) return true;
  if (basename.includes("edge") || basename.includes("msedge")) return true;
  if (basename.includes("brave")) return true;
  if (basename.includes("chromium")) return true;
  if (basename.includes("arc")) return true;
  return false;
}

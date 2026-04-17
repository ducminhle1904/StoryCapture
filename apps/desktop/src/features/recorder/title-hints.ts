/**
 * Plan 06-03 — preset-driven window-title hints for Playwright auto-follow.
 *
 * Phase 5's `start_capture_target` hardcoded `title_hint: "Chromium"` for
 * the Playwright auto-target sentinel. That worked only when the operator
 * had not customized `browser_executable` in Settings. Once they pointed
 * Playwright at Edge/Brave/Chrome-channel, pid→SCWindow matching still
 * succeeded via the pid fallback (D-15), but title-hint tie-breaking for
 * multi-window cases picked the wrong window.
 *
 * This map fixes that: given the BrowserRow preset (or executable-path
 * basename), return the localized window-title substring Chromium uses
 * for its own top-level frames on macOS. `find_window_by_pid` does a
 * case-insensitive substring match and falls back to "any window owned
 * by the pid" if no title matches — so an unknown key returns `undefined`
 * and the existing Phase 5 fallback path (D-15) preserves behavior.
 *
 * T-06-15 mitigation: callers logging the resolved hint MUST truncate to
 * 40 chars at most. The hints themselves are short (<=25 chars) but the
 * field is user-controllable through BrowserRow's path entry.
 */

/**
 * Canonical preset-key → title-hint map. Keys intentionally use the
 * lowercase tokens `BrowserRow`'s preset labels (Plan 06-02) lowercase-map
 * to — keeping a single source of truth.
 */
export const BROWSER_TITLE_HINTS: Readonly<Record<string, string>> = {
  chromium: "Chromium",
  chrome: "Google Chrome",
  "chrome-beta": "Google Chrome Beta",
  "chrome-dev": "Google Chrome Dev",
  "chrome-canary": "Google Chrome Canary",
  msedge: "Microsoft Edge",
  "msedge-beta": "Microsoft Edge Beta",
  "msedge-dev": "Microsoft Edge Dev",
  brave: "Brave Browser",
  arc: "Arc",
};

/**
 * Safe lookup. Returns `undefined` when:
 *
 * - the input is null/undefined/empty (bundled Playwright Chromium is in
 *   use; the caller should pass `undefined` through to `title_hint` so
 *   the Rust `find_window_by_pid` path relies purely on pid),
 * - the preset key is unknown (e.g. firefox, safari — Phase 6 does not
 *   auto-follow non-Chromium browsers; D-15 fallback still covers pid),
 *
 * and never throws.
 *
 * Accepts both raw preset keys ("msedge") and exec paths
 * ("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge").
 * The path branch matches on filename basename fragments, mirroring
 * `isChromiumFamily` (features/settings/browser-presets.ts).
 */
export function titleHintFor(
  preset: string | null | undefined,
): string | undefined {
  if (!preset) return undefined;
  const lower = preset.toLowerCase();
  const direct = BROWSER_TITLE_HINTS[lower];
  if (direct) return direct;

  // Path heuristic: take the filename basename of the exec path (macOS
  // app-wrapper: "/Applications/Foo.app/Contents/MacOS/Foo"). Order
  // matters — canary before chrome, beta before chrome, edge before
  // chrome (because Edge binaries don't contain "chrome").
  const basename = lower.split(/[\/\\]/).pop() ?? "";
  if (!basename) return undefined;
  if (basename.includes("chrome canary")) return BROWSER_TITLE_HINTS["chrome-canary"];
  if (basename.includes("chrome beta")) return BROWSER_TITLE_HINTS["chrome-beta"];
  if (basename.includes("chrome dev")) return BROWSER_TITLE_HINTS["chrome-dev"];
  if (basename.includes("microsoft edge beta"))
    return BROWSER_TITLE_HINTS["msedge-beta"];
  if (basename.includes("microsoft edge dev"))
    return BROWSER_TITLE_HINTS["msedge-dev"];
  if (basename.includes("microsoft edge")) return BROWSER_TITLE_HINTS["msedge"];
  if (basename.includes("brave")) return BROWSER_TITLE_HINTS["brave"];
  if (basename.includes("arc")) return BROWSER_TITLE_HINTS["arc"];
  if (basename.includes("google chrome")) return BROWSER_TITLE_HINTS["chrome"];
  if (basename.includes("chromium")) return BROWSER_TITLE_HINTS["chromium"];
  return undefined;
}

/**
 * Log-safe truncation of a title hint — T-06-15. Callers emitting the
 * hint into tracing fields MUST pass through this first.
 */
export function redactTitleHint(h: string | undefined | null): string {
  if (!h) return "<none>";
  return h.length > 40 ? `${h.slice(0, 40)}…` : h;
}

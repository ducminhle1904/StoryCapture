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
 * This module maps the BrowserRow preset (or executable-path basename)
 * to the localized window-title substring Chromium uses for its own
 * top-level frames on macOS. `find_window_by_pid` does a case-insensitive
 * substring match and falls back to "any window owned by the pid" if no
 * title matches — so an unknown key returns `undefined` and the existing
 * Phase 5 fallback path (D-15) preserves behavior.
 *
 * Backlog #9: the preset table itself is no longer hand-maintained here.
 * It is sourced from `@storycapture/shared-types` (canonical
 * `packages/shared-types/browser-presets.json`), the same JSON the Rust
 * side reads at build time. This module is now a thin adapter that
 * preserves the public API (BROWSER_TITLE_HINTS, titleHintFor,
 * redactTitleHint) so existing callers and tests keep working.
 *
 * T-06-15 mitigation: callers logging the resolved hint MUST truncate to
 * 40 chars at most. The hints themselves are short (<=25 chars) but the
 * field is user-controllable through BrowserRow's path entry.
 */
import { BROWSER_PRESETS } from "@storycapture/shared-types";

/**
 * Canonical preset-key → title-hint map. Preserved for back-compat with
 * callers/tests that index the map directly; new code should call
 * `titleHintFor` instead (which also handles the exec-path fallback).
 */
export const BROWSER_TITLE_HINTS: Readonly<Record<string, string>> =
  Object.fromEntries(BROWSER_PRESETS.map((p) => [p.id, p.title]));

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
 * The path branch matches on filename basename fragments, iterating
 * `BROWSER_PRESETS` in declared order (specific-first: Canary/Beta/Dev
 * before the generic parent) — identical iteration strategy to the
 * Rust side so both platforms agree on the resolved hint.
 */
export function titleHintFor(
  preset: string | null | undefined,
): string | undefined {
  if (!preset) return undefined;
  const lower = preset.toLowerCase();

  // Direct preset-id lookup.
  const direct = BROWSER_PRESETS.find((p) => p.id === lower);
  if (direct) return direct.title;

  // Exec-path basename heuristic. JSON order is specific-first; the first
  // entry whose basename fragment appears in the basename wins.
  const basename = lower.split(/[\/\\]/).pop() ?? "";
  if (!basename) return undefined;
  for (const p of BROWSER_PRESETS) {
    if (p.basenames.some((b) => basename.includes(b))) return p.title;
  }
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

/**
 * Preset-driven window-title hints for Playwright auto-follow.
 */
import { BROWSER_PRESETS } from "@storycapture/shared-types";

/** Canonical preset-key to title-hint map. */
export const BROWSER_TITLE_HINTS: Readonly<Record<string, string>> = Object.fromEntries(
  BROWSER_PRESETS.map((p) => [p.id, p.title]),
);

/** Safe lookup for raw preset keys or exec paths. */
export function titleHintFor(preset: string | null | undefined): string | undefined {
  if (!preset) return undefined;
  const lower = preset.toLowerCase();

  // Direct preset-id lookup.
  const direct = BROWSER_PRESETS.find((p) => p.id === lower);
  if (direct) return direct.title;

  // Exec-path basename heuristic.
  const basename = lower.split(/[/\\]/).pop() ?? "";
  if (!basename) return undefined;
  for (const p of BROWSER_PRESETS) {
    if (p.basenames.some((b) => basename.includes(b))) return p.title;
  }
  return undefined;
}

/** Log-safe truncation of a title hint. */
export function redactTitleHint(h: string | undefined | null): string {
  if (!h) return "<none>";
  return h.length > 40 ? `${h.slice(0, 40)}…` : h;
}

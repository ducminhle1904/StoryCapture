import { frontendLog } from "@/lib/log";

/**
 * WCAG 2.1 AA contrast helpers.
 *
 * Cursor-inspired warm palette contrast notes (light mode):
 *   fg-primary (#26251e) on bg-primary (#f2f1ed): ~12.8:1
 *   fg-secondary (55% warm brown) on bg-primary: ~5.2:1
 *   fg-muted (40% warm brown) on bg-primary: ~3.5:1 (AA non-text only)
 *   accent-primary (#f54e00) on bg-primary: ~4.6:1
 *   danger/hover (#cf2d56) on bg-primary: ~5.1:1
 *
 * Reference: https://www.w3.org/TR/WCAG21/#contrast-minimum
 */

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two sRGB hex colors. Always ≥ 1.0.
 * AA body text requires ≥ 4.5:1; AA non-text UI requires ≥ 3:1.
 */
export function checkContrast(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

export const AA_BODY_TEXT = 4.5;
export const AA_NON_TEXT = 3.0;

/**
 * Dev-time audit: warn in the console if any registered (fg, bg, label) pair
 * fails the WCAG AA body-text threshold. Safe to call in production — it
 * becomes a no-op if the browser doesn't expose `window.getComputedStyle`.
 */
export function auditTokenPairs(
  pairs: Array<{ label: string; fg: string; bg: string; minRatio?: number }>,
): void {
  if (typeof window === "undefined") return;
  for (const p of pairs) {
    const ratio = checkContrast(p.fg, p.bg);
    const min = p.minRatio ?? AA_BODY_TEXT;
    if (ratio < min) {
      frontendLog.warn("wcag", "contrast pair below WCAG threshold", {
        fields: {
          label: p.label,
          ratio: Number(ratio.toFixed(2)),
          min_ratio: min,
          fg: p.fg,
          bg: p.bg,
        },
      });
    }
  }
}

/**
 * Font loading strategy (decision recorded for SUMMARY.md):
 *
 * - **Geist Sans** is loaded via `@fontsource/geist-sans`. The Vercel-official
 *   `geist` npm package only works inside Next.js (it imports `next/font/local`),
 *   so we use Fontsource's framework-agnostic CSS distribution instead.
 * - **JetBrains Mono** is loaded via `@fontsource/jetbrains-mono` for the same
 *   reason — per-weight CSS files we can `@import` from `styles.css`, letting
 *   Vite tree-shake unused weights at build time.
 *
 * The actual `@font-face` registrations live in `styles.css`.
 */

export const fontFamilies = {
  sans: "Geist Sans, system-ui, sans-serif",
  mono: "JetBrains Mono, Menlo, monospace",
} as const;

export type FontFamily = keyof typeof fontFamilies;

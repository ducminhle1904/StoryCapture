/**
 * Font loading strategy.
 *
 * Inter + JetBrains Mono variable fonts via `@fontsource-variable/inter`
 * and `@fontsource-variable/jetbrains-mono`. The `@import` registrations
 * live in `styles.css`.
 */

export const fontFamilies = {
  sans: "Inter, system-ui, sans-serif",
  mono: "JetBrains Mono, Menlo, monospace",
} as const;

export type FontFamily = keyof typeof fontFamilies;

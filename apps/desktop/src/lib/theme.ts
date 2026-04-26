/**
 * Theme toggle + persistence.
 *
 * Dark is the default. The chosen mode is persisted in localStorage and
 * applied via `data-theme` on `<html>`.
 */

export type Theme = "dark" | "light";

const STORAGE_KEY = "storycapture.theme";

export function getTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage may be unavailable (private mode); silently ignore.
  }
}

export function toggleTheme(): Theme {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/** Call once on app mount to apply the persisted theme. */
export function applyPersistedTheme(): void {
  setTheme(getTheme());
}

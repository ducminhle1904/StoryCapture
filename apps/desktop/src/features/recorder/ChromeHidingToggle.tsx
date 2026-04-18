/**
 * Per-recording switch for Chromium app-mode (`--app=<meta.app>`): no
 * tab bar, no URL bar, no back/forward. Disabled for non-Chromium
 * presets since Safari/Firefox have no equivalent flag. Non-sticky —
 * the recorder-state field resets to false on mount and after reset().
 */

import { useId } from "react";
import { isChromiumFamily } from "@/features/settings/browser-presets";

interface ChromeHidingToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The active BrowserRow preset label / exec path. Null = bundled
   *  Playwright Chromium (also Chromium-family, enabled). */
  browserPreset: string | null;
  disabled?: boolean;
}

export function ChromeHidingToggle({
  checked,
  onChange,
  browserPreset,
  disabled,
}: ChromeHidingToggleProps) {
  const chromiumOk = isChromiumFamily(browserPreset);
  const effectiveDisabled = disabled || !chromiumOk;
  const id = useId();

  return (
    <label
      htmlFor={id}
      className={`flex items-center justify-between text-[var(--color-fg-secondary)] ${
        effectiveDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
      title={
        chromiumOk
          ? "Launch Chromium in app mode — no tab bar, no URL bar."
          : "Chrome-hiding requires a Chromium-family browser (Chrome/Edge/Brave)."
      }
    >
      <span>Hide browser chrome</span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label="Hide browser chrome during recording"
        disabled={effectiveDisabled}
        onClick={() => {
          if (!effectiveDisabled) onChange(!checked);
        }}
        className={`relative h-4 w-7 rounded-full transition-colors duration-150 ${
          checked && !effectiveDisabled
            ? "bg-[var(--color-accent-primary)]"
            : "bg-[var(--color-surface-400)]"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${
            checked ? "translate-x-3" : "translate-x-0"
          }`}
        />
      </button>
    </label>
  );
}

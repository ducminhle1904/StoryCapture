/**
 * Per-recording include-cursor switch. Non-sticky, defaults ON every
 * recording. The bool reaches both SCK `with_shows_cursor` and WGC
 * `CursorCaptureSettings` via `StartRecordingArgs.include_cursor`.
 */

import { useId } from "react";

interface CursorToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function CursorToggle({ checked, onChange, disabled }: CursorToggleProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={`flex items-center justify-between text-[var(--color-fg-secondary)] ${
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      }`}
      title="Include the mouse cursor in the captured video."
    >
      <span>Show cursor</span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label="Include cursor in recording"
        disabled={disabled}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        className={`relative h-4 w-7 rounded-full transition-colors duration-150 ${
          checked
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

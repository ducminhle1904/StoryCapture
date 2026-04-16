/**
 * ResolutionPicker (Plan 02-12b, Task 2).
 *
 * Single-select radio group for 720p / 1080p / 4K. Plan 11's
 * `export_validate_config` is the authoritative source on format+resolution
 * compatibility; this component just captures the user's pick.
 */

import { memo } from "react";

import type { ExportResolution } from "../state/export-slice";

const OPTIONS: Array<{ id: ExportResolution; label: string }> = [
  { id: "720p", label: "720p" },
  { id: "1080p", label: "1080p" },
  { id: "4k", label: "4K" },
];

export interface ResolutionPickerProps {
  value: ExportResolution;
  onChange: (next: ExportResolution) => void;
}

function ResolutionPickerBase({ value, onChange }: ResolutionPickerProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
        Resolution
      </legend>
      <div className="grid grid-cols-3 gap-2">
        {OPTIONS.map((opt) => (
          <label
            key={opt.id}
            className={`flex cursor-pointer items-center justify-center rounded-2xl border px-3 py-3 text-sm font-medium transition ${
              value === opt.id
                ? "border-[var(--color-accent-primary)]/50 bg-[var(--color-accent-primary)]/10 text-[var(--color-fg-primary)] shadow-[0_16px_32px_rgba(0,0,0,0.18)]"
                : "border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] text-[var(--color-fg-secondary)] hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-100)] hover:text-[var(--color-fg-primary)]"
            }`}
          >
            <input
              type="radio"
              name="export-resolution"
              value={opt.id}
              checked={value === opt.id}
              onChange={() => onChange(opt.id)}
              className="sr-only"
            />
            {opt.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export const ResolutionPicker = memo(ResolutionPickerBase);

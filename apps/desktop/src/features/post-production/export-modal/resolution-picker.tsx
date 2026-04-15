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
    <fieldset className="flex gap-2">
      <legend className="mb-1 text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
        Resolution
      </legend>
      {OPTIONS.map((opt) => (
        <label
          key={opt.id}
          className={`flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-sm ${
            value === opt.id
              ? "border-[var(--color-accent,#ff5b76)] bg-[var(--color-surface-hi)] text-[var(--color-fg)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]"
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
    </fieldset>
  );
}

export const ResolutionPicker = memo(ResolutionPickerBase);

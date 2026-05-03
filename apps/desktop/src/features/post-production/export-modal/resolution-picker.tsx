/**
 * ResolutionPicker — single-select radio group for source / presets / custom.
 * `export_validate_config` is the authoritative source on
 * format+resolution compatibility; this component just captures the
 * user's pick.
 */

import { memo } from "react";

import type { ExportResolution } from "../state/export-slice";

const OPTIONS: Array<{ id: ExportResolution; label: string }> = [
  { id: "match-source", label: "Source" },
  { id: "720p", label: "720p" },
  { id: "1080p", label: "1080p" },
  { id: "4k", label: "4K" },
  { id: "custom", label: "Custom" },
];

export interface ResolutionPickerProps {
  value: ExportResolution;
  customWidth: number;
  customHeight: number;
  onChange: (next: ExportResolution) => void;
  onCustomSizeChange: (next: { width: number; height: number }) => void;
}

function ResolutionPickerBase({
  value,
  customWidth,
  customHeight,
  onChange,
  onCustomSizeChange,
}: ResolutionPickerProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
        Resolution
      </legend>
      <div className="grid grid-cols-2 gap-2">
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
      {value === "custom" ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-xs text-[var(--color-fg-secondary)]">
            Width
            <input
              type="number"
              min={16}
              max={7680}
              step={2}
              value={customWidth}
              onChange={(event) =>
                onCustomSizeChange({ width: Number(event.target.value), height: customHeight })
              }
              className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-3 py-2 text-sm text-[var(--color-fg-primary)]"
            />
          </label>
          <label className="grid gap-1 text-xs text-[var(--color-fg-secondary)]">
            Height
            <input
              type="number"
              min={16}
              max={4320}
              step={2}
              value={customHeight}
              onChange={(event) =>
                onCustomSizeChange({ width: customWidth, height: Number(event.target.value) })
              }
              className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] px-3 py-2 text-sm text-[var(--color-fg-primary)]"
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}

export const ResolutionPicker = memo(ResolutionPickerBase);

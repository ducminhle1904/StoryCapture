/**
 * FormatCheckboxes — native checkbox group for the MP4 / WebM / GIF
 * multi-select. Keeps the component tree testable without pulling in a
 * dialog/checkbox primitive.
 */

import { memo } from "react";

import type { ExportFormat } from "../state/export-slice";

const OPTIONS: Array<{ id: ExportFormat; label: string }> = [
  { id: "mp4", label: "MP4 (H.264 + AAC)" },
  { id: "webm", label: "WebM (VP9)" },
  { id: "gif", label: "GIF (animated)" },
];

export interface FormatCheckboxesProps {
  value: readonly ExportFormat[];
  onChange: (next: ExportFormat[]) => void;
}

function FormatCheckboxesBase({ value, onChange }: FormatCheckboxesProps) {
  const set = new Set(value);
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-[11px] uppercase tracking-[0.2em] text-[var(--color-fg-muted)]">
        Formats
      </legend>
      <div className="grid gap-2">
        {OPTIONS.map((opt) => {
          const checked = set.has(opt.id);
          return (
            <label
              key={opt.id}
              className={`flex cursor-pointer items-center justify-between rounded-2xl border px-4 py-3 text-sm transition ${
                checked
                  ? "border-[var(--color-accent-primary)]/50 bg-[var(--color-accent-primary)]/10 text-[var(--color-fg-primary)] shadow-[0_16px_32px_rgba(0,0,0,0.18)]"
                  : "border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] text-[var(--color-fg-secondary)] hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-100)] hover:text-[var(--color-fg-primary)]"
              }`}
            >
              <div>
                <div className="font-medium">{opt.id.toUpperCase()}</div>
                <div className="mt-1 text-xs text-[var(--color-fg-muted)]">{opt.label}</div>
              </div>
              <input
                type="checkbox"
                name={`export-format-${opt.id}`}
                aria-label={`Export as ${opt.label}`}
                checked={checked}
                onChange={(e) => {
                  const next = new Set(set);
                  if (e.target.checked) next.add(opt.id);
                  else next.delete(opt.id);
                  onChange(Array.from(next));
                }}
                className="h-4 w-4 accent-[var(--color-accent-primary)]"
              />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export const FormatCheckboxes = memo(FormatCheckboxesBase);

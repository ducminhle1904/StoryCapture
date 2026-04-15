/**
 * FormatCheckboxes (Plan 02-12b, Task 2).
 *
 * Native checkbox group for the MP4 / WebM / GIF multi-select. Keeps the
 * component tree testable without pulling in a dialog/checkbox primitive.
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
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">
        Formats
      </legend>
      {OPTIONS.map((opt) => (
        <label
          key={opt.id}
          className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-fg)]"
        >
          <input
            type="checkbox"
            name={`export-format-${opt.id}`}
            aria-label={`Export as ${opt.label}`}
            checked={set.has(opt.id)}
            onChange={(e) => {
              const next = new Set(set);
              if (e.target.checked) next.add(opt.id);
              else next.delete(opt.id);
              onChange(Array.from(next));
            }}
            className="h-4 w-4 accent-[var(--color-accent,#ff5b76)]"
          />
          {opt.label}
        </label>
      ))}
    </fieldset>
  );
}

export const FormatCheckboxes = memo(FormatCheckboxesBase);

/**
 * ProgressBar (Plan 02-12b, Task 2).
 *
 * ARIA-labeled determinate progress bar. `pct` is 0–100.
 */

import { memo } from "react";

export interface ProgressBarProps {
  pct: number;
  label?: string;
}

function ProgressBarBase({ pct, label }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label ?? "Render progress"}
      className="h-1.5 w-full overflow-hidden rounded bg-[var(--color-border)]"
    >
      <div
        className="h-full bg-[var(--color-accent,#ff5b76)] transition-[width]"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export const ProgressBar = memo(ProgressBarBase);

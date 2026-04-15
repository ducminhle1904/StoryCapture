/**
 * JobRow (Plan 02-12b, Task 2).
 *
 * Single render job row in the queue widget popover. Shows format +
 * resolution + live progress + a cancel button.
 */

import { memo } from "react";
import { X } from "lucide-react";

import type { RenderJob, RenderProgress } from "@/ipc/render";
import { ProgressBar } from "./progress-bar";

export interface JobRowProps {
  job: RenderJob;
  progress?: RenderProgress;
  onCancel: () => void;
}

function JobRowBase({ job, progress, onCancel }: JobRowProps) {
  const pct = progress?.pct ?? job.progress_pct ?? 0;
  const label = `${job.format.toUpperCase()} ${job.resolution} @ ${job.fps}fps`;

  return (
    <div
      role="listitem"
      aria-label={`Render job ${label} — ${Math.round(pct)} percent complete`}
      className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-[var(--color-fg)]">{label}</span>
        <button
          type="button"
          aria-label={`Cancel ${label}`}
          onClick={onCancel}
          className="rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg)] hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <ProgressBar pct={pct} label={`${label} progress`} />
      <div className="flex justify-between text-[10px] text-[var(--color-fg-muted)]">
        <span>{job.status}</span>
        {progress ? (
          <span>
            {progress.fps.toFixed(1)} fps • {(progress.speed).toFixed(2)}×
          </span>
        ) : null}
      </div>
    </div>
  );
}

export const JobRow = memo(JobRowBase);

/**
 * JobRow — single render job row in the queue widget popover. Shows
 * format + resolution + live progress + a cancel button.
 */

import { ACTIVE_EXPORT_JOB_STATUSES } from "@storycapture/shared-types";
import { X } from "lucide-react";
import { memo } from "react";

import type { RenderJob, RenderProgress } from "@/ipc/render";
import { ProgressBar } from "./progress-bar";

export interface JobRowProps {
  job: RenderJob;
  progress?: RenderProgress;
  onCancel: (jobId: string) => void;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatEta(ms: number | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

const ACTIVE_STATUSES = new Set(ACTIVE_EXPORT_JOB_STATUSES);

function formatStatus(status: RenderJob["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function getStatusLabel(job: RenderJob, progress?: RenderProgress) {
  const status = ACTIVE_STATUSES.has(job.status) ? (progress?.status ?? job.status) : job.status;
  if (!ACTIVE_STATUSES.has(status)) return formatStatus(status);
  const phasePct = clampPercent(progress?.phase_pct ?? job.phase_progress_pct);
  return `${formatStatus(status)} · ${Math.round(phasePct)}%`;
}

function safeFailureMessage(error: string | null) {
  if (!error) {
    return "Check source media, output permissions, and available disk space, then retry.";
  }
  const firstLine = error.split(/\r?\n/, 1)[0] ?? "";
  const withoutPaths = firstLine
    .replace(/file:\/\/\/[\S]+/gi, "[file]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:;]+[\\/])*[^\s:;]+/g, "[file]")
    .trim();
  if (!withoutPaths || /^ffmpeg failed(?: for)?(?: \[file\])?$/i.test(withoutPaths)) {
    return "Check source media, output permissions, and available disk space, then retry.";
  }
  return withoutPaths.slice(0, 240);
}

function JobRowBase({ job, progress, onCancel }: JobRowProps) {
  const pct = clampPercent(progress?.pct ?? job.progress_pct ?? 0);
  const roundedPct = Math.round(pct);
  const label = `${job.format.toUpperCase()} ${job.resolution} @ ${job.fps}fps`;
  const statusLabel = getStatusLabel(job, progress);
  const eta = ACTIVE_STATUSES.has(job.status) ? formatEta(progress?.eta_ms) : null;

  return (
    <li
      aria-label={`Render job ${label} — ${roundedPct} percent complete`}
      className="flex flex-col gap-1 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-400)] p-3 text-xs"
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-[var(--color-fg)]">{label}</span>
        {ACTIVE_STATUSES.has(job.status) ? (
          <button
            type="button"
            aria-label={`Cancel ${label}`}
            onClick={() => onCancel(job.id)}
            className="rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-300)] hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <ProgressBar pct={pct} label={`${label} progress`} />
      <div className="flex justify-between gap-3 text-[10px] text-[var(--color-fg-muted)]">
        <span className="tabular-nums">{roundedPct}% complete</span>
        <span className="min-w-0 truncate text-right" title={statusLabel}>
          {statusLabel}
        </span>
      </div>
      {eta ? (
        <div className="text-right text-[10px] text-[var(--color-fg-muted)]">ETA {eta}</div>
      ) : null}
      {progress ? (
        <div className="flex justify-end text-[10px] text-[var(--color-fg-muted)]">
          <span>
            {progress.fps.toFixed(1)} fps • {progress.speed.toFixed(2)}×
          </span>
        </div>
      ) : null}
      {job.status === "completed" && job.output_path ? (
        <div className="truncate text-[10px] text-[var(--color-fg-muted)]" title={job.output_path}>
          Saved to {job.output_path}
        </div>
      ) : null}
      {job.recording_mode === "uncertified_development" ? (
        <div className="text-[10px] font-medium text-amber-400">
          Uncertified Development — upload and sharing are disabled
        </div>
      ) : null}
      {job.status === "failed" ? (
        <div className="text-[10px] leading-4 text-red-300" role="alert">
          {safeFailureMessage(job.error)}
        </div>
      ) : null}
    </li>
  );
}

export const JobRow = memo(JobRowBase);

/**
 * QueueWidget — top-bar dropdown showing active render jobs with live
 * progress. Polls `render_list_active(storyId)` every 3 s and merges in
 * live `RenderProgress` ticks from the shared channel subscription
 * (`useRenderProgress`). `render_list_active` is server-side filtered
 * by `story_id`; the widget renders whatever the backend returns.
 */

import { ACTIVE_EXPORT_JOB_STATUSES } from "@storycapture/shared-types";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useId, useState } from "react";

import { RENDER_KEYS, renderCancel, renderListActive } from "@/ipc/render";
import { useRenderProgress } from "../hooks/use-render-progress";
import { JobRow } from "./job-row";

export interface QueueWidgetProps {
  storyId: string;
}

export function QueueWidget({ storyId }: QueueWidgetProps) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const { data: jobs = [] } = useQuery({
    queryKey: RENDER_KEYS.listActive(storyId),
    queryFn: () => renderListActive(storyId),
    refetchInterval: 3000,
  });
  const progressMap = useRenderProgress();
  const handleCancel = useCallback((jobId: string) => {
    void renderCancel(jobId);
  }, []);

  const activeCount = jobs.filter((job) => ACTIVE_EXPORT_JOB_STATUSES.includes(job.status)).length;
  const queueLabel =
    activeCount === 0
      ? "Queue"
      : activeCount === 1
        ? "1 export active"
        : `${activeCount} exports active`;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={queueLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-2 text-xs text-[var(--color-fg)] hover:bg-[var(--color-surface-300)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
      >
        {activeCount > 0 ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {activeCount === 0 ? <span className="tabular-nums">{activeCount}</span> : null}
        <span className="text-[var(--color-fg-muted)]">{queueLabel}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-labelledby={headingId}
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3 shadow-[var(--shadow-card)]"
        >
          <h2
            id={headingId}
            className="mb-2 px-1 text-[11px] font-semibold uppercase text-[var(--color-fg-muted)]"
          >
            Render queue
          </h2>
          {jobs.length === 0 ? (
            <div className="p-2 text-xs text-[var(--color-fg-muted)]">No active exports.</div>
          ) : (
            <ul aria-label="Recent Render Jobs" className="space-y-2">
              {jobs.map((j) => (
                <JobRow key={j.id} job={j} progress={progressMap[j.id]} onCancel={handleCancel} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

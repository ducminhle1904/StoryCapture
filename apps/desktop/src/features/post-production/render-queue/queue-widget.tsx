/**
 * QueueWidget — top-bar dropdown showing active render jobs with live
 * progress. Polls `render_list_active(storyId)` every 3 s and merges in
 * live `RenderProgress` ticks from the shared channel subscription
 * (`useRenderProgress`). `render_list_active` is server-side filtered
 * by `story_id`; the widget renders whatever the backend returns.
 */

import { Button } from "@astryxdesign/core/Button";
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
      <Button
        label={queueLabel}
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        {activeCount > 0 ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {activeCount === 0 ? <span className="tabular-nums">{activeCount}</span> : null}
        <span>{queueLabel}</span>
      </Button>

      {open ? (
        <div
          role="dialog"
          aria-labelledby={headingId}
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-card)] p-3 shadow-[var(--shadow-med)]"
        >
          <h2
            id={headingId}
            className="mb-2 px-1 text-[11px] font-semibold uppercase text-[var(--color-text-secondary)]"
          >
            Render queue
          </h2>
          {jobs.length === 0 ? (
            <div className="p-2 text-xs text-[var(--color-text-secondary)]">No active exports.</div>
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

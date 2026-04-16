/**
 * QueueWidget (Plan 02-12b, Task 2).
 *
 * Top-bar dropdown that shows active render jobs with live progress.
 * Polls `render_list_active(storyId)` via TanStack Query every 3 s and
 * merges in live `RenderProgress` ticks from the shared channel
 * subscription (`useRenderProgress`).
 *
 * T-02-37: `render_list_active` is server-side filtered by `story_id`;
 * the widget just renders whatever the backend returns.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
  renderCancel,
  renderListActive,
  RENDER_KEYS,
} from "@/ipc/render";
import { useRenderProgress } from "../hooks/use-render-progress";
import { JobRow } from "./job-row";

export interface QueueWidgetProps {
  storyId: string;
}

export function QueueWidget({ storyId }: QueueWidgetProps) {
  const [open, setOpen] = useState(false);
  const { data: jobs = [] } = useQuery({
    queryKey: RENDER_KEYS.listActive(storyId),
    queryFn: () => renderListActive(storyId),
    refetchInterval: 3000,
  });
  const progressMap = useRenderProgress();

  const activeCount = jobs.length;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${activeCount} active render${activeCount === 1 ? "" : "s"}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-3 py-2 text-xs text-[var(--color-fg)] hover:bg-white/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
      >
        {activeCount > 0 ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : null}
        <span className="tabular-nums">{activeCount}</span>
        <span className="text-[var(--color-fg-muted)]">queue</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Render queue"
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,#151a22_0%,#121720_100%)] p-3 shadow-[0_24px_80px_rgba(0,0,0,0.32)]"
        >
          {jobs.length === 0 ? (
            <div className="p-2 text-xs text-[var(--color-fg-muted)]">
              No active renders.
            </div>
          ) : (
            <div role="list" aria-label="Active render jobs" className="space-y-2">
              {jobs.map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  progress={progressMap[j.id]}
                  onCancel={() => {
                    void renderCancel(j.id);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

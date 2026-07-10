/**
 * Queue slice. Mirrors the host's render queue state for UI consumption:
 * a map of active `RenderJob`s keyed by id + a per-job live progress map
 * fed by the `stream_render_progress` channel. Both are bounded by the
 * host's `render_list_active` response + the actor's pool capacity, so
 * there is no additional DoS surface here.
 */

import type { StateCreator } from "zustand";

import type { RenderJob, RenderProgress } from "@/ipc/render";

export interface QueueSlice {
  activeJobs: Record<string, RenderJob>;
  progressByJobId: Record<string, RenderProgress>;

  setActiveJobs: (jobs: RenderJob[]) => void;
  upsertJob: (job: RenderJob) => void;
  removeJob: (jobId: string) => void;
  applyProgress: (p: RenderProgress) => void;
  clearQueue: () => void;
}

export const createQueueSlice: StateCreator<QueueSlice, [], [], QueueSlice> = (set) => ({
  activeJobs: {},
  progressByJobId: {},

  setActiveJobs: (jobs) => {
    const next: Record<string, RenderJob> = {};
    for (const j of jobs) next[j.id] = j;
    set({ activeJobs: next });
  },
  upsertJob: (job) => set((s) => ({ activeJobs: { ...s.activeJobs, [job.id]: job } })),
  removeJob: (jobId) =>
    set((s) => {
      const { [jobId]: _, ...rest } = s.activeJobs;
      const { [jobId]: __, ...restProg } = s.progressByJobId;
      return { activeJobs: rest, progressByJobId: restProg };
    }),
  applyProgress: (p) => set((s) => ({ progressByJobId: { ...s.progressByJobId, [p.job_id]: p } })),
  clearQueue: () => set({ activeJobs: {}, progressByJobId: {} }),
});

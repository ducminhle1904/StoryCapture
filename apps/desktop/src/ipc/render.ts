/**
 * Render queue IPC wrappers.
 *
 * Typed wrappers around the `render_enqueue` / `render_cancel` /
 * `render_list_active` / `stream_render_progress` Tauri commands.
 * TanStack Query keys are defined here so all consumers share the same
 * cache namespace.
 */

import { invoke, Channel } from "@tauri-apps/api/core";

export type RenderStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface NewRenderJob {
  story_id: string;
  preset_id: string | null;
  /** "mp4" | "webm" | "gif" */
  format: string;
  /** "720p" | "1080p" | "4k" */
  resolution: string;
  fps: number;
  /** "low" | "med" | "high" */
  quality: string;
  priority: number;
  batch_id: string | null;
}

export interface RenderJob {
  id: string;
  story_id: string;
  preset_id: string | null;
  format: string;
  resolution: string;
  fps: number;
  quality: string;
  status: RenderStatus | string;
  progress_pct: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  priority: number;
  output_path: string | null;
  batch_id: string | null;
  created_at: number;
}

export interface RenderProgress {
  job_id: string;
  pct: number;
  frame: number;
  fps: number;
  speed: number;
  eta_ms: number;
}

/** TanStack Query cache keys — shared across hooks. */
export const RENDER_KEYS = {
  listActive: (storyId: string) => ["render", "list-active", storyId] as const,
};

export async function renderEnqueue(job: NewRenderJob): Promise<string> {
  return invoke<string>("render_enqueue", { job });
}

export async function renderCancel(jobId: string): Promise<void> {
  await invoke<void>("render_cancel", { jobId });
}

export async function renderListActive(storyId: string): Promise<RenderJob[]> {
  return invoke<RenderJob[]>("render_list_active", { storyId });
}

/**
 * Subscribe to the render progress stream. Single-subscriber per render
 * queue lifetime — the host re-arms the receiver when a new project is
 * opened. Returns the `Channel` so callers can keep it alive; dropping
 * the reference (or calling `onmessage = null`) tears down the subscription.
 */
export function streamRenderProgress(
  onProgress: (p: RenderProgress) => void,
): Promise<Channel<RenderProgress>> {
  const channel = new Channel<RenderProgress>();
  channel.onmessage = onProgress;
  return invoke<void>("stream_render_progress", { channel }).then(() => channel);
}

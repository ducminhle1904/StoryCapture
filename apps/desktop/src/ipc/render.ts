/**
 * Render queue IPC wrappers.
 *
 * Typed wrappers around the `render_cancel`, `render_list_active`, and
 * `stream_render_progress` Tauri commands.
 * TanStack Query keys are defined here so all consumers share the same
 * cache namespace.
 */

import type {
  ExportJobDto,
  ExportJobProgressDto,
  ExportJobStatus,
} from "@storycapture/shared-types";
import { Channel, invoke } from "@tauri-apps/api/core";

export type RenderStatus = ExportJobStatus;

export type RenderJob = ExportJobDto;

export type RenderProgress = ExportJobProgressDto;

/** TanStack Query cache keys — shared across hooks. */
export const RENDER_KEYS = {
  listActive: (storyId: string) => ["render", "list-active", storyId] as const,
};

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

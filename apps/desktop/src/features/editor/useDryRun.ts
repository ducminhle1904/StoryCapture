/**
 * Hook wrapping Dry-Run IPC.
 *
 * Provides `start(steps)` to launch a dry-run via `dryrun_start` Tauri command
 * and `cancel()` to abort via `dryrun_cancel`. Events stream through a
 * Tauri Channel into the Zustand dryRunStore.
 */

import { useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useDryRunStore, type DryRunEvent } from "./dryRunStore";

export interface StoryStep {
  id: string;
  verb: string;
  args: Record<string, string>;
  label?: string;
  line?: number;
}

export function useDryRun(projectId: string) {
  const store = useDryRunStore();

  const start = useCallback(
    async (steps: StoryStep[]) => {
      store.reset();
      store.togglePanel();
      const channel = new Channel<DryRunEvent>();
      channel.onmessage = (ev: DryRunEvent) => {
        store.handleEvent(ev);
      };
      const taskId = await invoke<string>("dryrun_start", {
        projectId,
        steps,
        channel,
      });
      store.setTaskId(taskId);
    },
    [projectId, store],
  );

  const cancel = useCallback(() => {
    if (store.taskId) {
      invoke("dryrun_cancel", { taskId: store.taskId });
    }
  }, [store]);

  return { start, cancel, state: store };
}

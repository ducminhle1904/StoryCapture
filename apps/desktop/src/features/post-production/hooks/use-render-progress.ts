/**
 * Subscribe to render-progress ticks and mirror them into local state.
 */

import { useEffect } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

import type { RenderProgress } from "@/ipc/render";
import { frontendLog } from "@/lib/log";
import { useEditorStore } from "../state/store";

let activeChannel: Channel<RenderProgress> | null = null;
let streamPromise: Promise<void> | null = null;

function ensureRenderProgressStream() {
  if (streamPromise) return;

  const channel = new Channel<RenderProgress>();
  activeChannel = channel;
  channel.onmessage = (p: RenderProgress) => {
    useEditorStore.getState().applyProgress(p);
  };

  streamPromise = invoke<void>("stream_render_progress", { channel })
    .catch((err) => {
      frontendLog.warn(
        "post-production/useRenderProgress",
        "stream_render_progress IPC subscription failed",
        { error: err },
      );
    })
    .finally(() => {
      if (activeChannel === channel) {
        activeChannel = null;
        streamPromise = null;
      }
    });
}

export function useRenderProgress(): Record<string, RenderProgress> {
  const progressByJobId = useEditorStore((s) => s.progressByJobId);

  useEffect(() => {
    ensureRenderProgressStream();
  }, []);

  return progressByJobId;
}

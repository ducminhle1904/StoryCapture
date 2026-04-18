/**
 * Subscribe to render-progress ticks and mirror them into local state.
 */

import { useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";

import type { RenderProgress } from "@/ipc/render";
import { useEditorStore } from "../state/store";

export function useRenderProgress(): Record<string, RenderProgress> {
  const [map, setMap] = useState<Record<string, RenderProgress>>({});
  const applyProgress = useEditorStore((s) => s.applyProgress);

  useEffect(() => {
    const channel = new Channel<RenderProgress>();
    channel.onmessage = (p: RenderProgress) => {
      setMap((prev) => ({ ...prev, [p.job_id]: p }));
      applyProgress(p);
    };
    // Fire-and-forget subscription.
    void invoke<void>("stream_render_progress", { channel }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[post-production] stream_render_progress failed", err);
    });

    return () => {
      // Drop the receiver on unmount.
      channel.onmessage = () => {};
    };
  }, [applyProgress]);

  return map;
}

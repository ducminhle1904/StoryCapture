/**
 * useRenderProgress (Plan 02-12b, Task 2).
 *
 * Subscribes to `stream_render_progress` — the host opens a Tauri
 * `Channel<RenderProgress>` that emits live per-job ticks. This hook
 * owns a single channel for the lifetime of the component that mounts
 * it (the QueueWidget today) and merges deltas into a per-job map.
 *
 * P12a's queue slice also exposes `applyProgress` — we feed each tick
 * there too so other consumers (inspector job row, future debug panel)
 * read from the same source.
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
    // Fire-and-forget: channel stays open for the lifetime of the host's
    // render queue; the component re-arms on re-mount.
    void invoke<void>("stream_render_progress", { channel }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[post-production] stream_render_progress failed", err);
    });

    return () => {
      // Drop the receiver so subsequent messages go nowhere. The host's
      // sender side will no-op once the channel is GC'd.
      channel.onmessage = () => {};
    };
  }, [applyProgress]);

  return map;
}

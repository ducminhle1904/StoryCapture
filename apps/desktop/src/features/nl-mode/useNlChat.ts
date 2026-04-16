/**
 * Hook wiring NL chat UI to Tauri IPC commands (Plan 03-17).
 *
 * Uses Channel<NlChatEvent> for streaming events from the Rust backend.
 */

import { useCallback, useMemo, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useNlStore, type ChatMessage } from "./nlStore";

export interface NlChatEvent {
  kind: "text" | "story_doc_ready" | "usage" | "error" | "done";
  delta?: string;
  message?: string;
  task_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  diff?: any[];
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  cost_usd?: number;
}

export function useNlChat(projectId: string) {
  const store = useNlStore();
  const taskIdRef = useRef<string | null>(null);

  const channel = useMemo(() => {
    const ch = new Channel<NlChatEvent>();
    return ch;
  }, []);

  const send = useCallback(
    async (message: string, currentStory: string) => {
      // Add user message
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        text: message,
        timestamp: Date.now(),
      };
      store.addMessage(userMsg);
      store.beginStream("pending");

      channel.onmessage = (ev: NlChatEvent) => {
        switch (ev.kind) {
          case "text":
            if (ev.delta) {
              useNlStore.getState().appendStream(ev.delta);
            }
            break;
          case "story_doc_ready":
            if (ev.diff && ev.task_id) {
              useNlStore.getState().setCards(
                ev.diff.map(
                  (d: { step_id?: string; old_text?: string; new_text?: string }) => ({
                    stepId: d.step_id ?? "unknown",
                    status: "pending" as const,
                    oldText: d.old_text,
                    newText: d.new_text,
                  }),
                ),
              );
            }
            break;
          case "error":
            useNlStore.getState().setError({
              kind: "network",
              message: ev.message ?? "Unknown error",
            });
            useNlStore.getState().endStream();
            break;
          case "done":
            useNlStore.getState().endStream();
            break;
        }
      };

      try {
        const taskId = await invoke<string>("nl_chat_send", {
          projectId,
          userMessage: message,
          currentStory,
          onEvent: channel,
        });
        taskIdRef.current = taskId;
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : String(err);

        // Detect rate limit vs auth vs network errors
        if (errMsg.includes("rate") || errMsg.includes("429")) {
          useNlStore.getState().setError({
            kind: "rate_limit",
            message: errMsg,
            retryAfterS: 30,
          });
        } else if (errMsg.includes("auth") || errMsg.includes("401")) {
          useNlStore.getState().setError({
            kind: "auth",
            message: errMsg,
          });
        } else {
          useNlStore.getState().setError({
            kind: "network",
            message: errMsg,
          });
        }
        useNlStore.getState().endStream();
      }
    },
    [projectId, channel, store],
  );

  const cancel = useCallback(async () => {
    if (taskIdRef.current) {
      try {
        await invoke("nl_cancel", { taskId: taskIdRef.current });
      } catch {
        // ignore cancel errors
      }
      taskIdRef.current = null;
      store.endStream();
    }
  }, [store]);

  return { send, cancel };
}

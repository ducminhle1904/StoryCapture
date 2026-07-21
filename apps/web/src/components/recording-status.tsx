"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * Live recording status indicator.
 *
 * Subscribes to sync.onRecordingStatus SSE for real-time updates.
 * Falls back to polling sync.listProjects every 5s after 3 consecutive
 * SSE reconnect failures (Hobby-tier graceful degradation).
 */

interface RecordingStatusProps {
  workspaceId: string;
  sseToken: string | null;
}

interface RecordingEvent {
  desktopId: string;
  status: string;
  projectName?: string;
}

export function RecordingStatus({ workspaceId, sseToken }: RecordingStatusProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [statuses, setStatuses] = useState<Map<string, RecordingEvent>>(new Map());
  const [isPolling, setIsPolling] = useState(false);
  const failCountRef = useRef(0);
  const MAX_SSE_FAILURES = 3;

  // SSE subscription for live recording status
  useEffect(() => {
    if (!sseToken || isPolling) return;

    const controller = new AbortController();

    async function subscribe() {
      try {
        const url = `/api/trpc/sync.onRecordingStatus?input=${encodeURIComponent(
          JSON.stringify({
            json: { workspaceId, token: sseToken },
          }),
        )}`;

        const response = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        failCountRef.current = 0; // Reset on successful connection
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const data = parsed?.result?.data?.json ?? parsed?.result?.data;
                if (data && data.desktopId !== "__keepalive__") {
                  setStatuses((prev) => {
                    const next = new Map(prev);
                    next.set(data.desktopId, data);
                    return next;
                  });
                }
              } catch {
                // Skip malformed SSE data
              }
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        failCountRef.current++;
        if (failCountRef.current >= MAX_SSE_FAILURES) {
          setIsPolling(true);
        } else {
          // Retry after a brief delay
          await new Promise((r) => setTimeout(r, 2000));
          if (!controller.signal.aborted) {
            subscribe();
          }
        }
      }
    }

    subscribe();

    return () => {
      controller.abort();
    };
  }, [workspaceId, sseToken, isPolling]);

  // Polling fallback: fetch projects every 5 seconds
  const pollingQuery = useQuery({
    ...trpc.sync.listProjects.queryOptions({ workspaceId }),
    enabled: isPolling,
    refetchInterval: 5_000,
  });

  // Sync polling data into statuses
  useEffect(() => {
    if (!isPolling || !pollingQuery.data) return;
    const next = new Map<string, RecordingEvent>();
    for (const p of pollingQuery.data) {
      if (p.recordingStatus && p.recordingStatus !== "idle") {
        next.set(p.desktopId, {
          desktopId: p.desktopId,
          status: p.recordingStatus,
          projectName: p.projectName,
        });
      }
    }
    setStatuses(next);
  }, [isPolling, pollingQuery.data]);

  // Filter out idle/ping statuses
  const activeRecordings = Array.from(statuses.values()).filter(
    (s) => s.status !== "idle" && s.status !== "ping",
  );

  if (activeRecordings.length === 0) {
    return null;
  }

  return (
    <Banner
      status="error"
      title="Recording in progress"
      description={isPolling ? "Live stream unavailable; using polling." : undefined}
      defaultIsExpanded
    >
      <div className="mt-2 space-y-1">
        {activeRecordings.map((r) => (
          <div key={r.desktopId} className="flex items-center justify-between text-sm">
            <span className="text-[var(--color-text-primary)]">{r.projectName ?? r.desktopId}</span>
            <Badge variant="error" label={formatStatus(r.status)} />
          </div>
        ))}
      </div>
    </Banner>
  );
}

function formatStatus(status: string): string {
  if (status === "recording") return "Recording...";
  if (status.startsWith("step:")) {
    const parts = status.slice(5).split("/");
    return `Step ${parts[0]} of ${parts[1]}`;
  }
  return status;
}

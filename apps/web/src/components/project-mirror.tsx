"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { formatWorkflowType, summarizeWorkflowState, workflowSteps } from "@/lib/workflows";
import { useTRPC } from "@/trpc/client";

/**
 * Project mirror list — shows synced desktop projects with metadata.
 *
 * Subscribes to sync.onProjectUpdates SSE for live changes.
 * Falls back to polling sync.listProjects every 5s after 3 SSE failures.
 * Story source is displayed read-only.
 */

interface ProjectMirrorProps {
  workspaceId: string;
  sseToken: string | null;
}

interface ProjectData {
  desktopId: string;
  projectName: string;
  storySource?: string;
  workflowType?: string | null;
  workflowState?: unknown;
  recordingStatus?: string;
  lastSyncedAt: string;
}

interface ProjectPayload {
  desktopId: string;
  projectName: string;
  storySource?: string | null;
  workflowType?: string | null;
  workflowState?: unknown;
  recordingStatus?: string | null;
  lastSyncedAt: string;
}

function normalizeProject(input: ProjectPayload): ProjectData {
  return {
    desktopId: input.desktopId,
    projectName: input.projectName,
    storySource: input.storySource ?? undefined,
    workflowType: input.workflowType ?? undefined,
    workflowState: input.workflowState ?? undefined,
    recordingStatus: input.recordingStatus ?? undefined,
    lastSyncedAt: input.lastSyncedAt,
  };
}

function sameProject(a: ProjectData | undefined, b: ProjectData): boolean {
  return (
    !!a &&
    a.desktopId === b.desktopId &&
    a.projectName === b.projectName &&
    a.storySource === b.storySource &&
    a.workflowType === b.workflowType &&
    a.recordingStatus === b.recordingStatus &&
    a.lastSyncedAt === b.lastSyncedAt &&
    JSON.stringify(a.workflowState) === JSON.stringify(b.workflowState)
  );
}

export function ProjectMirror({ workspaceId, sseToken }: ProjectMirrorProps) {
  const trpc = useTRPC();

  const [projects, setProjects] = useState<Map<string, ProjectData>>(new Map());
  const [isPolling, setIsPolling] = useState(false);
  const failCountRef = useRef(0);
  const MAX_SSE_FAILURES = 3;

  // Initial load via query
  const initialQuery = useQuery({
    ...trpc.sync.listProjects.queryOptions({ workspaceId }),
    refetchInterval: isPolling ? 5_000 : false,
  });

  // Populate from initial query
  useEffect(() => {
    if (!initialQuery.data) return;
    setProjects((prev) => {
      const next = new Map<string, ProjectData>();
      let changed = prev.size !== initialQuery.data.length;
      for (const p of initialQuery.data) {
        const project = normalizeProject(p);
        if (!sameProject(prev.get(project.desktopId), project)) changed = true;
        next.set(project.desktopId, project);
      }
      return changed ? next : prev;
    });
  }, [initialQuery.data]);

  // SSE subscription for live project updates
  useEffect(() => {
    if (!sseToken || isPolling) return;

    const controller = new AbortController();

    async function subscribe() {
      try {
        const url = `/api/trpc/sync.onProjectUpdates?input=${encodeURIComponent(
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

        failCountRef.current = 0;
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
                if (data && data.desktopId !== "__keepalive__" && data.type !== "keepalive") {
                  setProjects((prev) => {
                    const project = normalizeProject(data);
                    if (sameProject(prev.get(project.desktopId), project)) return prev;
                    const next = new Map(prev);
                    next.set(project.desktopId, project);
                    return next;
                  });
                }
              } catch {
                // Skip malformed SSE data
              }
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        failCountRef.current++;
        if (failCountRef.current >= MAX_SSE_FAILURES) {
          setIsPolling(true);
        } else {
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

  const projectList = Array.from(projects.values()).sort(
    (a, b) => new Date(b.lastSyncedAt).getTime() - new Date(a.lastSyncedAt).getTime(),
  );

  if (projectList.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center">
        <p className="text-sm text-zinc-500">
          No synced projects yet. Start the desktop app and sync a project.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {isPolling && (
        <p className="text-xs text-zinc-500">
          Live updates unavailable. Refreshing every 5 seconds (polling).
        </p>
      )}

      {projectList.map((p) => (
        <div key={p.desktopId} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-medium text-zinc-100">{p.projectName}</h3>
              <p className="mt-0.5 text-xs text-zinc-500">
                Last synced: {formatTimestamp(p.lastSyncedAt)}
              </p>
            </div>

            <StatusBadge status={p.recordingStatus} />
          </div>

          {p.storySource && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-300">
                Story source (read-only)
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
                {p.storySource}
              </pre>
            </details>
          )}

          {p.workflowType && (
            <WorkflowSummary workflowType={p.workflowType} workflowState={p.workflowState} />
          )}
        </div>
      ))}
    </div>
  );
}

function WorkflowSummary({
  workflowType,
  workflowState,
}: {
  workflowType: string;
  workflowState?: unknown;
}) {
  const counts = summarizeWorkflowState(workflowState);
  const steps = workflowSteps(workflowState);
  const label = formatWorkflowType(workflowType) ?? workflowType;

  return (
    <details className="mt-3 rounded border border-zinc-800 bg-zinc-950/50 p-3">
      <summary className="cursor-pointer text-xs text-zinc-300">
        {label}
        {Object.keys(counts).length > 0 && (
          <span className="ml-2 text-zinc-500">
            {Object.entries(counts)
              .map(([status, count]) => `${status}: ${count}`)
              .join(" · ")}
          </span>
        )}
      </summary>
      {steps.length > 0 && (
        <ol className="mt-3 space-y-2">
          {steps.map((step) => (
            <li key={step.id} className="rounded border border-zinc-800 bg-zinc-900 p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-zinc-200">{step.title}</span>
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-400">
                  {step.status}
                </span>
              </div>
              {step.sceneName && <p className="mt-1 text-zinc-500">Scene: {step.sceneName}</p>}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function StatusBadge({ status }: { status?: string }) {
  if (!status || status === "idle") {
    return <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-500">Idle</span>;
  }

  if (status === "recording" || status.startsWith("step:")) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-red-950/50 px-2 py-0.5 text-xs text-red-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
        {status === "recording" ? "Recording" : `Step ${status.slice(5).replace("/", " of ")}`}
      </span>
    );
  }

  return (
    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{status}</span>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return date.toLocaleDateString();
  } catch {
    return iso;
  }
}

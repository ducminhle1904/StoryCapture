"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
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
      <EmptyState
        title="No synced projects yet"
        description="Start the desktop app and sync a project."
      />
    );
  }

  return (
    <div className="space-y-3">
      {isPolling && (
        <Banner
          status="warning"
          title="Live updates unavailable"
          description="Refreshing every 5 seconds."
        />
      )}

      {projectList.map((p) => (
        <Card key={p.desktopId} padding={4}>
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-sm font-medium text-[var(--color-text-primary)]">
                {p.projectName}
              </h3>
              <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                Last synced: {formatTimestamp(p.lastSyncedAt)}
              </p>
            </div>

            <StatusBadge status={p.recordingStatus} />
          </div>

          {p.storySource && (
            <div className="mt-3">
              <Collapsible trigger="Story source (read-only)" defaultIsOpen={false}>
                <pre className="mt-2 max-h-48 overflow-auto rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-body)] p-3 font-mono text-xs text-[var(--color-text-secondary)]">
                  {p.storySource}
                </pre>
              </Collapsible>
            </div>
          )}

          {p.workflowType && (
            <WorkflowSummary workflowType={p.workflowType} workflowState={p.workflowState} />
          )}
        </Card>
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
    <div className="mt-3">
      <Collapsible
        defaultIsOpen={false}
        trigger={
          <span className="text-xs text-[var(--color-text-primary)]">
            {label}
            {Object.keys(counts).length > 0 && (
              <span className="ml-2 text-[var(--color-text-secondary)]">
                {Object.entries(counts)
                  .map(([status, count]) => `${status}: ${count}`)
                  .join(" · ")}
              </span>
            )}
          </span>
        }
      >
        {steps.length > 0 && (
          <ol className="mt-3 space-y-2">
            {steps.map((step) => (
              <li
                key={step.id}
                className="rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-muted)] p-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[var(--color-text-primary)]">{step.title}</span>
                  <Badge variant="neutral" label={step.status} />
                </div>
                {step.sceneName && (
                  <p className="mt-1 text-[var(--color-text-secondary)]">Scene: {step.sceneName}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Collapsible>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  if (!status || status === "idle") {
    return <Badge variant="neutral" label="Idle" />;
  }

  if (status === "recording" || status.startsWith("step:")) {
    return (
      <Badge
        variant="error"
        label={
          status === "recording" ? "Recording" : `Step ${status.slice(5).replace("/", " of ")}`
        }
      />
    );
  }

  return <Badge variant="neutral" label={status} />;
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

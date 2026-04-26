"use client";

import { useEffect, useState } from "react";
import { RecordingStatus } from "@/components/recording-status";
import { ProjectMirror } from "@/components/project-mirror";

/**
 * Desktop sync dashboard — recording-status banner, synced project mirror,
 * and connection status indicator. Metadata-only (no video files shown here).
 */

// TODO: workspace selection — for now uses query param or first workspace
function useWorkspaceId(): string | null {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    // Check URL params first
    const params = new URLSearchParams(window.location.search);
    const wsId = params.get("workspaceId");
    if (wsId) {
      setWorkspaceId(wsId);
      return;
    }

    // Fetch user's first workspace
    async function fetchWorkspace() {
      try {
        const res = await fetch("/api/trpc/user.workspaces", {
          headers: { "x-trpc-source": "nextjs-react" },
        });
        const data = await res.json();
        const workspaces = data?.result?.data?.json;
        if (Array.isArray(workspaces) && workspaces.length > 0) {
          setWorkspaceId(workspaces[0].workspace.id);
        }
      } catch {
        // Silently fail — user may not have workspaces
      }
    }

    fetchWorkspace();
  }, []);

  return workspaceId;
}

function useSseToken(): string | null {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    async function mint() {
      try {
        const res = await fetch("/api/auth/mint-sse-jwt");
        if (res.ok) {
          const data = await res.json();
          setToken(data.token);
        }
      } catch {
        // Will retry on next mount
      }
    }

    mint();

    // Refresh every 14 minutes (JWT expires at 15 min)
    const interval = setInterval(mint, 14 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return token;
}

export default function SyncPage() {
  const workspaceId = useWorkspaceId();
  const sseToken = useSseToken();

  if (!workspaceId) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-50">Desktop Sync</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Loading workspace...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-50">Desktop Sync</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Live view of desktop project metadata and recording status
          </p>
        </div>

        <ConnectionIndicator connected={!!sseToken} />
      </div>

      {/* Recording status banner */}
      {sseToken && (
        <RecordingStatus workspaceId={workspaceId} sseToken={sseToken} />
      )}

      {/* Synced projects */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-zinc-200">
          Synced Projects
        </h2>
        <ProjectMirror workspaceId={workspaceId} sseToken={sseToken} />
      </section>
    </div>
  );
}

function ConnectionIndicator({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2 w-2 rounded-full ${
          connected ? "bg-green-500" : "bg-zinc-600"
        }`}
      />
      <span className="text-xs text-zinc-400">
        {connected ? "Connected to desktop" : "Desktop offline"}
      </span>
    </div>
  );
}

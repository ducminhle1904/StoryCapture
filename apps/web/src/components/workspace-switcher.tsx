"use client";

import { useState, useRef, useEffect } from "react";
import { useTRPC } from "@/trpc/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

/**
 * Workspace switcher dropdown.
 * Shows all user workspaces with role badges, personal badge,
 * and a "Create Workspace" option.
 */
export function WorkspaceSwitcher({
  currentWorkspaceId,
}: {
  currentWorkspaceId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const workspacesQuery = useQuery(trpc.workspace.list.queryOptions());

  const createMutation = useMutation(
    trpc.workspace.create.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: trpc.workspace.list.queryKey() });
        setShowCreate(false);
        setNewName("");
        setOpen(false);
        router.push(`/workspace/${data.id}`);
      },
    }),
  );

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setShowCreate(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const workspaces = workspacesQuery.data ?? [];
  const currentWorkspace = workspaces.find(
    (w) => w.workspaceId === currentWorkspaceId,
  );

  const roleBadgeColor: Record<string, string> = {
    OWNER: "bg-amber-900/50 text-amber-300",
    EDITOR: "bg-blue-900/50 text-blue-300",
    VIEWER: "bg-zinc-800 text-zinc-400",
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-700 hover:bg-zinc-800"
      >
        <span className="max-w-[180px] truncate">
          {currentWorkspace?.name ?? "Select workspace"}
        </span>
        <svg
          className={`h-4 w-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-64 rounded-xl border border-zinc-800 bg-zinc-900 py-1 shadow-xl">
          <div className="max-h-64 overflow-y-auto">
            {workspaces.map((w) => (
              <button
                key={w.workspaceId}
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(`/workspace/${w.workspaceId}`);
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-800 ${
                  w.workspaceId === currentWorkspaceId
                    ? "bg-zinc-800/50 text-zinc-100"
                    : "text-zinc-300"
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  <span className="truncate">{w.name}</span>
                  {w.isPersonal && (
                    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                      Personal
                    </span>
                  )}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${roleBadgeColor[w.role]}`}
                >
                  {w.role}
                </span>
              </button>
            ))}
          </div>

          <div className="border-t border-zinc-800">
            {showCreate ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newName.trim()) {
                    createMutation.mutate({ name: newName.trim() });
                  }
                }}
                className="p-2"
              >
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Workspace name"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
                  autoFocus
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="submit"
                    disabled={createMutation.isPending || !newName.trim()}
                    className="rounded-lg bg-zinc-200 px-3 py-1 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-300 disabled:opacity-50"
                  >
                    {createMutation.isPending ? "Creating..." : "Create"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreate(false);
                      setNewName("");
                    }}
                    className="rounded-lg px-3 py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                Create Workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

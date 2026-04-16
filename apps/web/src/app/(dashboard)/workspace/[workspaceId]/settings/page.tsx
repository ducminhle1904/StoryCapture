"use client";

import { useTRPC } from "@/trpc/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useState, useEffect } from "react";

/**
 * Workspace settings page. Owner-only editing of name/slug + delete.
 * Personal workspace cannot be deleted.
 */
export default function WorkspaceSettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const workspaceQuery = useQuery(
    trpc.workspace.getById.queryOptions({ workspaceId }),
  );

  const workspace = workspaceQuery.data;
  const isOwner = workspace?.currentUserRole === "OWNER";

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setSlug(workspace.slug);
    }
  }, [workspace]);

  const updateMutation = useMutation(
    trpc.workspace.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.workspace.getById.queryKey({ workspaceId }),
        });
        queryClient.invalidateQueries({
          queryKey: trpc.workspace.list.queryKey(),
        });
      },
    }),
  );

  const deleteMutation = useMutation(
    trpc.workspace.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.workspace.list.queryKey(),
        });
        router.push("/");
      },
    }),
  );

  if (workspaceQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-sm text-red-400">Workspace not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-50">
          Workspace Settings
        </h1>
        <p className="mt-1 text-sm text-zinc-500">{workspace.name}</p>
      </div>

      {/* Name & slug editor */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
        <h2 className="mb-4 text-sm font-semibold text-zinc-200">General</h2>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="ws-name"
              className="mb-1 block text-xs text-zinc-500"
            >
              Workspace name
            </label>
            <input
              id="ws-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isOwner}
              className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="ws-slug"
              className="mb-1 block text-xs text-zinc-500"
            >
              Slug
            </label>
            <input
              id="ws-slug"
              type="text"
              value={slug}
              onChange={(e) =>
                setSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, ""),
                )
              }
              disabled={!isOwner}
              className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-zinc-600">
              Lowercase alphanumeric and hyphens only.
            </p>
          </div>

          {isOwner && (
            <button
              type="button"
              onClick={() => {
                updateMutation.mutate({
                  workspaceId,
                  ...(name !== workspace.name ? { name } : {}),
                  ...(slug !== workspace.slug ? { slug } : {}),
                });
              }}
              disabled={
                updateMutation.isPending ||
                (name === workspace.name && slug === workspace.slug)
              }
              className="rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300 disabled:opacity-50"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </button>
          )}

          {updateMutation.error && (
            <p className="text-sm text-red-400">
              {updateMutation.error.message}
            </p>
          )}
          {updateMutation.isSuccess && (
            <p className="text-sm text-green-400">Settings updated.</p>
          )}
        </div>
      </section>

      {/* Danger zone */}
      {isOwner && !workspace.isPersonal && (
        <section className="rounded-xl border border-red-900/50 bg-zinc-900 p-5">
          <h2 className="mb-2 text-sm font-semibold text-red-400">
            Danger Zone
          </h2>
          <p className="mb-4 text-xs text-zinc-500">
            Deleting a workspace removes all members and invites. Videos in the
            workspace will no longer be associated with any workspace.
          </p>
          <button
            type="button"
            onClick={() => {
              if (
                confirm(
                  `Delete "${workspace.name}"? This action cannot be undone.`,
                )
              ) {
                deleteMutation.mutate({ workspaceId });
              }
            }}
            disabled={deleteMutation.isPending}
            className="rounded-lg bg-red-900/50 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-900 disabled:opacity-50"
          >
            {deleteMutation.isPending
              ? "Deleting..."
              : "Delete Workspace"}
          </button>
          {deleteMutation.error && (
            <p className="mt-2 text-sm text-red-400">
              {deleteMutation.error.message}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

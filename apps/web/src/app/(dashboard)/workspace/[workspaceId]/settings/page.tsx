"use client";

import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTRPC } from "@/trpc/client";

/**
 * Workspace settings page. Owner-only editing of name/slug + delete.
 * Personal workspace cannot be deleted.
 */
export default function WorkspaceSettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const workspaceQuery = useQuery(trpc.workspace.getById.queryOptions({ workspaceId }));

  const workspace = workspaceQuery.data;
  const isOwner = workspace?.currentUserRole === "OWNER";

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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
        <Spinner label="Loading workspace settings" />
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="flex items-center justify-center py-20">
        <Banner status="error" title="Workspace not found" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Workspace Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{workspace.name}</p>
      </div>

      {/* Name & slug editor */}
      <Card padding={5}>
        <h2 className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">General</h2>

        <div className="space-y-4">
          <TextInput
            label="Workspace name"
            value={name}
            onChange={setName}
            isDisabled={!isOwner}
            width="100%"
            className="max-w-md"
          />

          <TextInput
            label="Slug"
            value={slug}
            onChange={(value) => setSlug(value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            isDisabled={!isOwner}
            description="Lowercase alphanumeric and hyphens only."
            width="100%"
            className="max-w-md"
          />

          {isOwner && (
            <Button
              label="Save changes"
              variant="primary"
              onClick={() => {
                updateMutation.mutate({
                  workspaceId,
                  ...(name !== workspace.name ? { name } : {}),
                  ...(slug !== workspace.slug ? { slug } : {}),
                });
              }}
              isLoading={updateMutation.isPending}
              isDisabled={
                updateMutation.isPending || (name === workspace.name && slug === workspace.slug)
              }
            />
          )}

          {updateMutation.error && (
            <Banner
              status="error"
              title="Could not update workspace"
              description={updateMutation.error.message}
            />
          )}
          {updateMutation.isSuccess && <Banner status="success" title="Settings updated" />}
        </div>
      </Card>

      {/* Danger zone */}
      {isOwner && !workspace.isPersonal && (
        <Card variant="red" padding={5}>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-error)]">Danger Zone</h2>
          <p className="mb-4 text-xs text-[var(--color-text-secondary)]">
            Deleting a workspace removes all members and invites. Videos in the workspace will no
            longer be associated with any workspace.
          </p>
          <Button
            label="Delete workspace"
            variant="destructive"
            onClick={() => setShowDeleteConfirm(true)}
            isDisabled={deleteMutation.isPending}
          />
          {deleteMutation.error && (
            <div className="mt-3">
              <Banner
                status="error"
                title="Could not delete workspace"
                description={deleteMutation.error.message}
              />
            </div>
          )}
        </Card>
      )}

      <AlertDialog
        isOpen={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete workspace?"
        description={`Delete “${workspace.name}”? This action cannot be undone.`}
        cancelLabel="Cancel"
        actionLabel="Delete workspace"
        actionVariant="destructive"
        isActionLoading={deleteMutation.isPending}
        onAction={() => deleteMutation.mutate({ workspaceId })}
      />
    </div>
  );
}

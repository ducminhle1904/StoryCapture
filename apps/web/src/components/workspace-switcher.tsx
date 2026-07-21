"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Popover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Role } from "@/generated/prisma/client";
import { useTRPC } from "@/trpc/client";

/**
 * Workspace switcher dropdown.
 * Shows all user workspaces with role badges, personal badge,
 * and a "Create Workspace" option.
 */
export interface WorkspaceListItem {
  workspaceId: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  role: Role;
  videoCount: number;
  memberCount: number;
}

export function WorkspaceSwitcher({
  currentWorkspaceId,
  initialData,
}: {
  currentWorkspaceId?: string;
  initialData?: WorkspaceListItem[];
}) {
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const router = useRouter();
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  // When initialData is provided by the server component, TanStack Query
  // renders immediately without a client-side fetch, eliminating the
  // double-fetch. It will still revalidate in the background per staleTime.
  const workspacesQuery = useQuery({
    ...trpc.workspace.list.queryOptions(),
    ...(initialData ? { initialData } : {}),
  });

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

  const workspaces = workspacesQuery.data ?? [];
  const currentWorkspace = workspaces.find((w) => w.workspaceId === currentWorkspaceId);

  const roleBadgeVariants = {
    OWNER: "warning",
    EDITOR: "info",
    VIEWER: "neutral",
  } as const;

  const content = (
    <div className="w-64 space-y-2 p-2">
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {workspaces.map((workspace) => (
          <Button
            key={workspace.workspaceId}
            label={workspace.name}
            variant={workspace.workspaceId === currentWorkspaceId ? "secondary" : "ghost"}
            className="w-full justify-between"
            onClick={() => {
              setOpen(false);
              router.push(`/workspace/${workspace.workspaceId}`);
            }}
            endContent={
              <span className="flex items-center gap-1">
                {workspace.isPersonal && <Badge variant="neutral" label="Personal" />}
                <Badge variant={roleBadgeVariants[workspace.role]} label={workspace.role} />
              </span>
            }
          />
        ))}
      </div>

      {showCreate ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (newName.trim()) {
              createMutation.mutate({ name: newName.trim() });
            }
          }}
          className="space-y-2 border-t border-[var(--color-border)] pt-2"
        >
          <TextInput
            label="Workspace name"
            isLabelHidden
            value={newName}
            onChange={setNewName}
            placeholder="Workspace name"
            width="100%"
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              label="Create"
              variant="primary"
              size="sm"
              isLoading={createMutation.isPending}
              isDisabled={createMutation.isPending || !newName.trim()}
            />
            <Button
              label="Cancel"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowCreate(false);
                setNewName("");
              }}
            />
          </div>
        </form>
      ) : (
        <div className="border-t border-[var(--color-border)] pt-2">
          <Button
            label="Create workspace"
            variant="ghost"
            className="w-full justify-start"
            icon={
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            }
            onClick={() => setShowCreate(true)}
          />
        </div>
      )}
    </div>
  );

  return (
    <Popover
      label="Select workspace"
      isOpen={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) setShowCreate(false);
      }}
      placement="below"
      alignment="start"
      width={272}
      content={content}
    >
      <Button
        label={currentWorkspace?.name ?? "Select workspace"}
        variant="secondary"
        className="max-w-56"
        endContent={
          <svg
            className={`h-4 w-4 text-[var(--color-text-secondary)] transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        }
      >
        <span className="max-w-[180px] truncate">
          {currentWorkspace?.name ?? "Select workspace"}
        </span>
      </Button>
    </Popover>
  );
}

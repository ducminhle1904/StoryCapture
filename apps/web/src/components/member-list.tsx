"use client";

import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

type Member = {
  id: string;
  userId: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
  joinedAt: Date;
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
  };
};

/**
 * Member list with role badges, role change, and remove actions.
 * Owner badge is visually distinct (amber). Owner-only actions gated by currentUserRole.
 */
export function MemberList({
  workspaceId,
  members,
  currentUserRole,
  currentUserId,
}: {
  workspaceId: string;
  members: Member[];
  currentUserRole: "OWNER" | "EDITOR" | "VIEWER";
  currentUserId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);

  const updateRoleMutation = useMutation(
    trpc.workspace.updateMemberRole.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.workspace.getById.queryKey({ workspaceId }),
        });
        setEditingUserId(null);
      },
    }),
  );

  const removeMemberMutation = useMutation(
    trpc.workspace.removeMember.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.workspace.getById.queryKey({ workspaceId }),
        });
        setMemberToRemove(null);
      },
    }),
  );

  const roleBadgeVariants = {
    OWNER: "warning",
    EDITOR: "info",
    VIEWER: "neutral",
  } as const;

  const roleOptions = [
    { value: "OWNER", label: "Owner" },
    { value: "EDITOR", label: "Editor" },
    { value: "VIEWER", label: "Viewer" },
  ];

  const confirmRemove = () => {
    if (!memberToRemove) return;
    removeMemberMutation.mutate({
      workspaceId,
      userId: memberToRemove.userId,
    });
  };

  return (
    <div className="space-y-2">
      {members.map((member) => (
        <Card key={member.id} padding={3} className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {member.user.image ? (
              <img
                src={member.user.image}
                alt={member.user.name ?? "Member avatar"}
                className="h-9 w-9 rounded-full"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-background-muted)] text-sm font-medium text-[var(--color-text-primary)]">
                {member.user.name?.charAt(0)?.toUpperCase() ?? "?"}
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                {member.user.name ?? "Unknown"}
                {member.userId === currentUserId && (
                  <span className="ml-1 text-xs text-[var(--color-text-secondary)]">(you)</span>
                )}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">{member.user.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {editingUserId === member.userId && currentUserRole === "OWNER" ? (
              <Selector
                label={`Role for ${member.user.name ?? member.user.email ?? "member"}`}
                isLabelHidden
                size="sm"
                width={120}
                options={roleOptions}
                value={member.role}
                onChange={(role) => {
                  updateRoleMutation.mutate({
                    workspaceId,
                    userId: member.userId,
                    role: role as "OWNER" | "EDITOR" | "VIEWER",
                  });
                }}
                isDisabled={updateRoleMutation.isPending}
              />
            ) : (
              <Badge variant={roleBadgeVariants[member.role]} label={member.role} />
            )}

            {currentUserRole === "OWNER" && member.userId !== currentUserId && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  label={editingUserId === member.userId ? "Done" : "Edit"}
                  onClick={() =>
                    setEditingUserId(editingUserId === member.userId ? null : member.userId)
                  }
                />
                <Button
                  size="sm"
                  variant="destructive"
                  label="Remove"
                  onClick={() => setMemberToRemove(member)}
                  isDisabled={removeMemberMutation.isPending}
                />
              </>
            )}
          </div>
        </Card>
      ))}

      <AlertDialog
        isOpen={memberToRemove !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setMemberToRemove(null);
        }}
        title="Remove member?"
        description={`Remove ${memberToRemove?.user.name ?? memberToRemove?.user.email ?? "this member"} from this workspace?`}
        cancelLabel="Cancel"
        actionLabel="Remove"
        actionVariant="destructive"
        isActionLoading={removeMemberMutation.isPending}
        onAction={confirmRemove}
      />
    </div>
  );
}

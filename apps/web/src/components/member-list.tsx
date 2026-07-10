"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
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
      },
    }),
  );

  const roleBadgeStyles: Record<string, string> = {
    OWNER: "bg-amber-900/50 text-amber-300 border-amber-800",
    EDITOR: "bg-blue-900/50 text-blue-300 border-blue-800",
    VIEWER: "bg-zinc-800 text-zinc-400 border-zinc-700",
  };

  return (
    <div className="space-y-2">
      {members.map((member) => (
        <div
          key={member.id}
          className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3"
        >
          <div className="flex items-center gap-3">
            {member.user.image ? (
              <Image
                src={member.user.image}
                alt={member.user.name ?? "Member avatar"}
                width={36}
                height={36}
                unoptimized
                className="h-9 w-9 rounded-full"
              />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-700 text-sm font-medium text-zinc-300">
                {member.user.name?.charAt(0)?.toUpperCase() ?? "?"}
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-zinc-200">
                {member.user.name ?? "Unknown"}
                {member.userId === currentUserId && (
                  <span className="ml-1 text-xs text-zinc-500">(you)</span>
                )}
              </p>
              <p className="text-xs text-zinc-500">{member.user.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {editingUserId === member.userId && currentUserRole === "OWNER" ? (
              <select
                value={member.role}
                onChange={(e) => {
                  updateRoleMutation.mutate({
                    workspaceId,
                    userId: member.userId,
                    role: e.target.value as "OWNER" | "EDITOR" | "VIEWER",
                  });
                }}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
              >
                <option value="OWNER">Owner</option>
                <option value="EDITOR">Editor</option>
                <option value="VIEWER">Viewer</option>
              </select>
            ) : (
              <span
                className={`rounded border px-2 py-0.5 text-xs font-medium ${roleBadgeStyles[member.role]}`}
              >
                {member.role}
              </span>
            )}

            {currentUserRole === "OWNER" && member.userId !== currentUserId && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setEditingUserId(editingUserId === member.userId ? null : member.userId)
                  }
                  className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                >
                  {editingUserId === member.userId ? "Done" : "Edit"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        `Remove ${member.user.name ?? member.user.email} from this workspace?`,
                      )
                    ) {
                      removeMemberMutation.mutate({
                        workspaceId,
                        userId: member.userId,
                      });
                    }
                  }}
                  disabled={removeMemberMutation.isPending}
                  className="rounded-lg px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-950 hover:text-red-300"
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

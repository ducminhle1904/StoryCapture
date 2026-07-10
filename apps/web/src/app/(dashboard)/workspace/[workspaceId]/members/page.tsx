"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { InviteForm } from "@/components/invite-form";
import { MemberList } from "@/components/member-list";
import { useTRPC } from "@/trpc/client";

/**
 * Workspace members page.
 * Shows invite form (editor+), member list with role management (owner only).
 */
export default function WorkspaceMembersPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { data: session } = useSession();
  const trpc = useTRPC();

  const workspaceQuery = useQuery(trpc.workspace.getById.queryOptions({ workspaceId }));

  const workspace = workspaceQuery.data;

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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-50">Members</h1>
        <p className="mt-1 text-sm text-zinc-500">
          {workspace.name} &middot; {workspace.members.length} member
          {workspace.members.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Invite form (editor+ only) */}
      <InviteForm workspaceId={workspaceId} currentUserRole={workspace.currentUserRole} />

      {/* Member list */}
      <MemberList
        workspaceId={workspaceId}
        members={workspace.members}
        currentUserRole={workspace.currentUserRole}
        currentUserId={session?.user?.id ?? ""}
      />
    </div>
  );
}

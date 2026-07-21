"use client";

import { Banner } from "@astryxdesign/core/Banner";
import { Spinner } from "@astryxdesign/core/Spinner";
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
        <Spinner label="Loading workspace members" />
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Members</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
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

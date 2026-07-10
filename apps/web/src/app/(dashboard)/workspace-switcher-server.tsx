import { type WorkspaceListItem, WorkspaceSwitcher } from "@/components/workspace-switcher";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Server component that fetches workspace list and passes it as initialData
 * to the client WorkspaceSwitcher, eliminating the redundant client-side fetch
 * on mount. TanStack Query will still revalidate in the background per its
 * staleTime config, but the UI renders immediately without a loading state.
 */
export async function WorkspaceSwitcherServer({
  currentWorkspaceId,
}: {
  currentWorkspaceId?: string;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    return <WorkspaceSwitcher currentWorkspaceId={currentWorkspaceId} />;
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.user.id },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          isPersonal: true,
          _count: { select: { videos: true, members: true } },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  const initialData: WorkspaceListItem[] = memberships.map((m) => ({
    workspaceId: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    isPersonal: m.workspace.isPersonal,
    role: m.role,
    videoCount: m.workspace._count.videos,
    memberCount: m.workspace._count.members,
  }));

  return <WorkspaceSwitcher currentWorkspaceId={currentWorkspaceId} initialData={initialData} />;
}

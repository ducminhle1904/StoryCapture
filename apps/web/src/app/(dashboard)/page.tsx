import { auth } from "@/lib/auth";
import { ScCard, ScEmptyState } from "@storycapture/ui";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { WorkspaceSwitcherServer } from "./workspace-switcher-server";

/**
 * Dashboard home page.
 *
 * Shows:
 * - Workspace switcher in header
 * - Video grid as primary content (from personal/default workspace)
 * - Per-video quick actions: View, Analytics, Edit
 * - Navigation context for all features
 */
export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/sign-in");
  }

  // Find the user's personal workspace (default view)
  const personalMembership = await prisma.workspaceMember.findFirst({
    where: {
      userId: session.user.id,
      workspace: { isPersonal: true },
    },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true },
      },
    },
  });

  const defaultWorkspaceId = personalMembership?.workspace.id;

  // Fetch videos from the default workspace
  const videos = defaultWorkspaceId
    ? await prisma.video.findMany({
        where: { workspaceId: defaultWorkspaceId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          slug: true,
          projectName: true,
          fileName: true,
          fileSizeBytes: true,
          status: true,
          isPublic: true,
          createdAt: true,
        },
      })
    : [];

  return (
    <div className="space-y-8">
      {/* Header with workspace switcher */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-50">Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Your recordings and demo videos
          </p>
        </div>
        <WorkspaceSwitcherServer
          currentWorkspaceId={defaultWorkspaceId}
        />
      </div>

      {/* Quick stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <ScCard>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Total Videos
          </p>
          <p className="mt-1 text-2xl font-bold text-zinc-100">
            {videos.length}
          </p>
        </ScCard>
        <ScCard>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Published
          </p>
          <p className="mt-1 text-2xl font-bold text-zinc-100">
            {videos.filter((v) => v.isPublic).length}
          </p>
        </ScCard>
        <ScCard>
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Ready
          </p>
          <p className="mt-1 text-2xl font-bold text-zinc-100">
            {videos.filter((v) => v.status === "READY").length}
          </p>
        </ScCard>
      </div>

      {/* Video grid */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-zinc-200">
          Recent Videos
        </h2>

        {videos.length === 0 ? (
          <ScEmptyState
            title="No videos yet"
            body="Upload your first demo video from the desktop app"
            align="center"
            className="py-16"
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {videos.map((video) => (
              <ScCard
                key={video.id}
                className="group transition-colors hover:border-[var(--sc-border-strong)]"
              >
                {/* Video thumbnail placeholder */}
                <div className="flex h-32 items-center justify-center rounded-lg bg-zinc-800">
                  <svg
                    className="h-8 w-8 text-zinc-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>

                {/* Video info */}
                <div className="mt-3">
                  <h3 className="truncate font-medium text-zinc-100">
                    {video.projectName}
                  </h3>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        video.status === "READY"
                          ? "bg-emerald-900/50 text-emerald-300"
                          : video.status === "UPLOADING"
                            ? "bg-amber-900/50 text-amber-300"
                            : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      {video.status}
                    </span>
                    {video.isPublic && (
                      <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
                        Public
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {new Date(video.createdAt).toLocaleDateString()}
                  </p>
                </div>

                {/* Quick actions */}
                <div className="mt-3 flex gap-2 border-t border-zinc-800 pt-3">
                  <Link
                    href={`/watch/${video.slug}`}
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
                  >
                    View
                  </Link>
                  <Link
                    href={`/analytics/${video.id}`}
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
                  >
                    Analytics
                  </Link>
                  <Link
                    href={`/videos/${video.id}`}
                    className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
                  >
                    Edit
                  </Link>
                </div>
              </ScCard>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createPresignedGetUrl } from "@/lib/r2";
import { R2_BUCKET } from "@/lib/r2";
import Link from "next/link";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";

/**
 * Workspace home page. Shows workspace header, video grid, quick links.
 * Only accessible to workspace members.
 */
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in");

  const { workspaceId } = await params;

  // Check membership
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: {
        userId: session.user.id,
        workspaceId,
      },
    },
  });

  if (!membership) redirect("/");

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      isPersonal: true,
      _count: { select: { members: true } },
    },
  });

  if (!workspace) redirect("/");

  // Fetch videos
  const videos = await prisma.video.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      projectName: true,
      status: true,
      isPublic: true,
      thumbnailR2Key: true,
      createdAt: true,
    },
  });

  // Generate thumbnail URLs
  const videosWithThumbs = await Promise.all(
    videos.map(async (v) => ({
      ...v,
      thumbnailUrl: v.thumbnailR2Key
        ? await createPresignedGetUrl(R2_BUCKET, v.thumbnailR2Key)
        : null,
    })),
  );

  const statusBadge: Record<string, string> = {
    READY: "bg-green-900/50 text-green-300",
    UPLOADING: "bg-yellow-900/50 text-yellow-300",
    PROCESSING: "bg-blue-900/50 text-blue-300",
    FAILED: "bg-red-900/50 text-red-300",
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-zinc-50">
              {workspace.name}
            </h1>
            {workspace.isPersonal && (
              <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                Personal
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {workspace._count.members} member
            {workspace._count.members !== 1 ? "s" : ""} &middot;{" "}
            {videos.length} video{videos.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <WorkspaceSwitcher currentWorkspaceId={workspaceId} />
          <div className="flex gap-2">
            <Link
              href={`/workspace/${workspaceId}/members`}
              className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-300"
            >
              Members
            </Link>
            <Link
              href={`/workspace/${workspaceId}/settings`}
              className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-300"
            >
              Settings
            </Link>
          </div>
        </div>
      </div>

      {/* Video grid */}
      {videosWithThumbs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 py-16 text-center">
          <p className="text-sm text-zinc-500">No videos yet.</p>
          <p className="mt-1 text-xs text-zinc-600">
            Upload recordings from the StoryCapture desktop app.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videosWithThumbs.map((video) => (
            <Link
              key={video.id}
              href={`/videos/${video.id}`}
              className="group overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-700"
            >
              {/* Thumbnail */}
              <div className="aspect-video bg-zinc-800">
                {video.thumbnailUrl ? (
                  <img
                    src={video.thumbnailUrl}
                    alt={video.projectName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-zinc-700">
                    <svg
                      className="h-10 w-10"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3">
                <div className="flex items-start justify-between">
                  <h3 className="truncate text-sm font-medium text-zinc-200 group-hover:text-zinc-100">
                    {video.projectName}
                  </h3>
                  <div className="flex shrink-0 items-center gap-1.5 ml-2">
                    {!video.isPublic && (
                      <svg
                        className="h-3.5 w-3.5 text-zinc-600"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-label="Private"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                        />
                      </svg>
                    )}
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadge[video.status] ?? "bg-zinc-800 text-zinc-500"}`}
                    >
                      {video.status}
                    </span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-zinc-600">
                  {new Date(video.createdAt).toLocaleDateString()}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

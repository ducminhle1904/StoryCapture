import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import Link from "next/link";
import { redirect } from "next/navigation";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createPresignedGetUrl, R2_BUCKET } from "@/lib/r2";

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

  const statusBadge: Record<string, BadgeVariant> = {
    READY: "success",
    UPLOADING: "warning",
    PROCESSING: "info",
    FAILED: "error",
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
              {workspace.name}
            </h1>
            {workspace.isPersonal && <Badge variant="neutral" label="Personal" />}
          </div>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {workspace._count.members} member
            {workspace._count.members !== 1 ? "s" : ""} &middot; {videos.length} video
            {videos.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <WorkspaceSwitcher currentWorkspaceId={workspaceId} />
          <div className="flex gap-2">
            <Button
              as={Link}
              href={`/workspace/${workspaceId}/members`}
              label="Members"
              variant="secondary"
            />
            <Button
              as={Link}
              href={`/workspace/${workspaceId}/settings`}
              label="Settings"
              variant="secondary"
            />
          </div>
        </div>
      </div>

      {/* Video grid */}
      {videosWithThumbs.length === 0 ? (
        <EmptyState
          title="No videos yet"
          description="Upload recordings from the StoryCapture desktop app."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videosWithThumbs.map((video) => (
            <Link key={video.id} href={`/videos/${video.id}`} className="group">
              <Card padding={0} className="overflow-hidden">
                {/* Thumbnail */}
                <div className="aspect-video bg-[var(--color-background-muted)]">
                  {video.thumbnailUrl ? (
                    <img
                      src={video.thumbnailUrl}
                      alt={video.projectName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[var(--color-text-disabled)]">
                      <svg
                        aria-hidden="true"
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
                    <h3 className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                      {video.projectName}
                    </h3>
                    <div className="flex shrink-0 items-center gap-1.5 ml-2">
                      {!video.isPublic && (
                        <svg
                          className="h-3.5 w-3.5 text-[var(--color-text-disabled)]"
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
                      <Badge
                        variant={statusBadge[video.status] ?? "neutral"}
                        label={video.status}
                      />
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    {new Date(video.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

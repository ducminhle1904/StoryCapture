import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Your recordings and demo videos
          </p>
        </div>
        <WorkspaceSwitcherServer currentWorkspaceId={defaultWorkspaceId} />
      </div>

      {/* Quick stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card padding={4}>
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
            Total Videos
          </p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-text-primary)]">
            {videos.length}
          </p>
        </Card>
        <Card padding={4}>
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
            Published
          </p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-text-primary)]">
            {videos.filter((v) => v.isPublic).length}
          </p>
        </Card>
        <Card padding={4}>
          <p className="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
            Ready
          </p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-text-primary)]">
            {videos.filter((v) => v.status === "READY").length}
          </p>
        </Card>
      </div>

      {/* Video grid */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-[var(--color-text-primary)]">
          Recent Videos
        </h2>

        {videos.length === 0 ? (
          <EmptyState
            title="No videos yet"
            description="Upload your first demo video from the desktop app."
            icon={
              <svg
                className="h-12 w-12 text-[var(--color-text-disabled)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {videos.map((video) => (
              <Card key={video.id} padding={4} className="group">
                {/* Video thumbnail placeholder */}
                <div className="flex h-32 items-center justify-center rounded-[var(--radius-element)] bg-[var(--color-background-muted)]">
                  <svg
                    aria-hidden="true"
                    className="h-8 w-8 text-[var(--color-text-disabled)]"
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
                  <h3 className="truncate font-medium text-[var(--color-text-primary)]">
                    {video.projectName}
                  </h3>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge
                      variant={
                        video.status === "READY"
                          ? "success"
                          : video.status === "UPLOADING"
                            ? "warning"
                            : "neutral"
                      }
                      label={video.status}
                    />
                    {video.isPublic && <Badge variant="info" label="Public" />}
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    {new Date(video.createdAt).toLocaleDateString()}
                  </p>
                </div>

                {/* Quick actions */}
                <div className="mt-3 flex gap-2 border-t border-[var(--color-border)] pt-3">
                  <Button
                    as={Link}
                    href={`/watch/${video.slug}`}
                    label="View"
                    variant="secondary"
                    size="sm"
                  />
                  <Button
                    as={Link}
                    href={`/analytics/${video.id}`}
                    label="Analytics"
                    variant="secondary"
                    size="sm"
                  />
                  <Button
                    as={Link}
                    href={`/videos/${video.id}`}
                    label="Edit"
                    variant="secondary"
                    size="sm"
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

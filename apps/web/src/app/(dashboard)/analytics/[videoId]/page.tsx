import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AnalyticsDashboard } from "@/components/analytics-dashboard";

interface AnalyticsPageProps {
  params: Promise<{ videoId: string }>;
}

interface SceneBoundary {
  sceneIndex: number;
  label: string;
  startTimeSec: number;
}

/**
 * Auth-gated analytics dashboard page for a specific video.
 * Verifies user has editor/owner access to the video's workspace (T-04-29).
 */
export default async function AnalyticsPage({ params }: AnalyticsPageProps) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/sign-in");
  }

  const { videoId } = await params;

  // Fetch video + verify workspace membership
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: {
      id: true,
      projectName: true,
      slug: true,
      workspaceId: true,
      sceneBoundaries: true,
    },
  });

  if (!video) {
    notFound();
  }

  // T-04-29: Verify user is member of the workspace
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: {
        userId: session.user.id,
        workspaceId: video.workspaceId,
      },
    },
  });

  if (!membership) {
    notFound();
  }

  // Extract scene labels from boundaries
  const sceneBoundaries = (video.sceneBoundaries ?? []) as unknown as SceneBoundary[];
  const sceneLabels = sceneBoundaries.map((sb) => sb.label);

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Analytics: {video.projectName}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            View performance metrics for this video
          </p>
        </div>
        <a
          href={`/watch/${video.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-zinc-800 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
        >
          View video
        </a>
      </div>

      {/* Dashboard */}
      <AnalyticsDashboard videoId={video.id} sceneLabels={sceneLabels} />
    </div>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createPresignedGetUrl, R2_BUCKET } from "@/lib/r2";
import { WatchViewer } from "@/components/watch-viewer";

interface WatchPageProps {
  params: Promise<{ slug: string }>;
}

interface SceneBoundary {
  sceneIndex: number;
  label: string;
  startTimeSec: number;
}

/**
 * Fetch video data for the watch page.
 * Used by both generateMetadata and the page component.
 */
async function getVideo(slug: string) {
  const video = await prisma.video.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      projectName: true,
      status: true,
      isPublic: true,
      sceneBoundaries: true,
      r2Key: true,
      thumbnailR2Key: true,
    },
  });

  if (!video || video.status !== "READY") return null;
  return video;
}

/**
 * Generate metadata for the watch page.
 * D-02: Private videos get noindex/nofollow. Public videos get full SEO tags.
 */
export async function generateMetadata({
  params,
}: WatchPageProps): Promise<Metadata> {
  const { slug } = await params;
  const video = await getVideo(slug);

  if (!video) {
    return { title: "Video Not Found - StoryCapture" };
  }

  const thumbnailUrl = video.thumbnailR2Key
    ? await createPresignedGetUrl(R2_BUCKET, video.thumbnailR2Key)
    : null;

  const base: Metadata = {
    title: `${video.projectName} - StoryCapture`,
    description: `Watch ${video.projectName} demo video on StoryCapture.`,
  };

  if (video.isPublic) {
    // Public: full SEO + Open Graph
    return {
      ...base,
      openGraph: {
        title: video.projectName,
        description: `Watch ${video.projectName} demo video on StoryCapture.`,
        type: "video.other",
        ...(thumbnailUrl ? { images: [{ url: thumbnailUrl }] } : {}),
      },
    };
  }

  // Private (D-02): noindex, still accessible via direct link (unlisted)
  return {
    ...base,
    robots: { index: false, follow: false },
  };
}

/**
 * Public viewer page at /watch/<slug>.
 * Server Component that fetches video data directly via Prisma,
 * then renders the client-side WatchViewer.
 *
 * D-02: Private videos are unlisted (accessible via link, noindex meta set above).
 */
export default async function WatchPage({ params }: WatchPageProps) {
  const { slug } = await params;
  const video = await getVideo(slug);

  if (!video) {
    notFound();
  }

  // Generate presigned URLs server-side (works for both public + private/unlisted)
  const videoUrl = await createPresignedGetUrl(R2_BUCKET, video.r2Key);
  const thumbnailUrl = video.thumbnailR2Key
    ? await createPresignedGetUrl(R2_BUCKET, video.thumbnailR2Key)
    : null;

  // Parse scene boundaries from JSON
  const sceneBoundaries = (video.sceneBoundaries ?? []) as unknown as SceneBoundary[];
  const chapters = sceneBoundaries.map((sb) => ({
    label: sb.label,
    startTimeSec: sb.startTimeSec,
  }));

  return (
    <div className="flex min-h-screen items-start justify-center bg-zinc-950 px-4 py-8">
      <WatchViewer
        videoUrl={videoUrl}
        thumbnailUrl={thumbnailUrl}
        chapters={chapters}
        projectName={video.projectName}
      />
    </div>
  );
}

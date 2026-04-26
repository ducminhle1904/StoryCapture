import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createPresignedGetUrl, R2_BUCKET } from "@/lib/r2";
import { EmbedPlayer } from "@/components/embed-player";

interface EmbedPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Minimal embeddable viewer for iframe embedding.
 * Fetches by video ID (not slug) for stable embed URLs.
 * X-Frame-Options is NOT set, allowing embedding in any origin.
 */
export default async function EmbedPage({ params }: EmbedPageProps) {
  const { id } = await params;

  const video = await prisma.video.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      r2Key: true,
      thumbnailR2Key: true,
    },
  });

  if (!video || video.status !== "READY") {
    notFound();
  }

  const videoUrl = await createPresignedGetUrl(R2_BUCKET, video.r2Key);
  const thumbnailUrl = video.thumbnailR2Key
    ? await createPresignedGetUrl(R2_BUCKET, video.thumbnailR2Key)
    : null;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-black p-0">
      <EmbedPlayer src={videoUrl} poster={thumbnailUrl} />
    </div>
  );
}

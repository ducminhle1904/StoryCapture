import { type NextRequest, NextResponse } from "next/server";
import { requireDesktopAuth } from "@/lib/desktop-auth";
import { prisma } from "@/lib/prisma";
import { createPresignedPartUrl, createPresignedPutUrl, R2_BUCKET } from "@/lib/r2";

/**
 * POST /api/upload/presign
 *
 * Returns a presigned PUT URL for a single part or a thumbnail.
 * Validates desktop JWT.
 *
 * Body: { r2Key, uploadId, partNumber } for multipart parts
 *   OR: { r2Key, type: "thumbnail" } for thumbnail single-object upload
 *
 * partNumber must be 1-10000 per S3 multipart spec; presigned URLs use the
 * S3 API domain only.
 */
export async function POST(req: NextRequest) {
  const auth = await requireDesktopAuth(req);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

  const body = await req.json();
  const { r2Key, uploadId, partNumber, type } = body;

  if (!r2Key) {
    return NextResponse.json({ error: "Missing r2Key" }, { status: 400 });
  }

  // Thumbnail presign request
  if (type === "thumbnail") {
    const thumbnailKey = r2Key.replace(/\.[^.]+$/, "-thumb.jpg");
    const presignedUrl = await createPresignedPutUrl(R2_BUCKET, thumbnailKey, "image/jpeg");
    return NextResponse.json({ presignedUrl, thumbnailR2Key: thumbnailKey });
  }

  // Multipart part presign request
  if (!uploadId || partNumber == null) {
    return NextResponse.json({ error: "Missing uploadId or partNumber" }, { status: 400 });
  }

  if (partNumber < 1 || partNumber > 10000) {
    return NextResponse.json({ error: "partNumber must be between 1 and 10000" }, { status: 400 });
  }

  // Verify user owns the in-progress upload
  const video = await prisma.video.findFirst({
    where: {
      r2Key,
      uploadId,
      uploaderId: userId,
      status: "UPLOADING",
    },
    select: { id: true },
  });

  if (!video) {
    return NextResponse.json(
      { error: "No in-progress upload found for this key" },
      { status: 404 },
    );
  }

  const presignedUrl = await createPresignedPartUrl(R2_BUCKET, r2Key, uploadId, partNumber);

  return NextResponse.json({ presignedUrl, partNumber });
}

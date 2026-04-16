import { NextRequest, NextResponse } from "next/server";
import { verifyDesktopToken } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";
import { R2_BUCKET, createPresignedPartUrl, createPresignedPutUrl } from "@/lib/r2";

/**
 * POST /api/upload/presign
 *
 * Returns a presigned PUT URL for a single part or a thumbnail.
 * Validates desktop JWT (T-04-12).
 *
 * Body: { r2Key, uploadId, partNumber } for multipart parts
 *   OR: { r2Key, type: "thumbnail" } for thumbnail single-object upload
 *
 * Pitfall 2: partNumber validated 1-10000.
 * Pitfall 3: presigned URL uses S3 API domain only.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing authorization" }, { status: 401 });
  }

  let userId: string;
  try {
    const result = await verifyDesktopToken(authHeader.slice(7));
    userId = result.userId;
  } catch {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  const body = await req.json();
  const { r2Key, uploadId, partNumber, type } = body;

  if (!r2Key) {
    return NextResponse.json({ error: "Missing r2Key" }, { status: 400 });
  }

  // Thumbnail presign request
  if (type === "thumbnail") {
    const thumbnailKey = r2Key.replace(/\.[^.]+$/, "-thumb.jpg");
    const presignedUrl = await createPresignedPutUrl(
      R2_BUCKET,
      thumbnailKey,
      "image/jpeg",
    );
    return NextResponse.json({ presignedUrl, thumbnailR2Key: thumbnailKey });
  }

  // Multipart part presign request
  if (!uploadId || partNumber == null) {
    return NextResponse.json(
      { error: "Missing uploadId or partNumber" },
      { status: 400 },
    );
  }

  if (partNumber < 1 || partNumber > 10000) {
    return NextResponse.json(
      { error: "partNumber must be between 1 and 10000" },
      { status: 400 },
    );
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

  const presignedUrl = await createPresignedPartUrl(
    R2_BUCKET,
    r2Key,
    uploadId,
    partNumber,
  );

  return NextResponse.json({ presignedUrl, partNumber });
}

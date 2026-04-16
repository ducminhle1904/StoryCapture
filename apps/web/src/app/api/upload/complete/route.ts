import { NextRequest, NextResponse } from "next/server";
import { verifyDesktopToken } from "@/lib/jwt";
import { prisma } from "@/lib/prisma";
import {
  r2Client,
  R2_BUCKET,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@/lib/r2";

/**
 * POST /api/upload/complete
 *
 * Finalizes a multipart upload. Transitions video to READY.
 * Also handles abort via `action: "abort"`.
 * Validates desktop JWT (T-04-12).
 *
 * Body for complete: { videoId, r2Key, uploadId, parts: [{ PartNumber, ETag }], thumbnailR2Key }
 * Body for abort:    { videoId, r2Key, uploadId, action: "abort" }
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
  const { videoId, r2Key, uploadId, action } = body;

  if (!videoId || !r2Key || !uploadId) {
    return NextResponse.json(
      { error: "Missing required fields: videoId, r2Key, uploadId" },
      { status: 400 },
    );
  }

  // Handle abort
  if (action === "abort") {
    await r2Client.send(
      new AbortMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        UploadId: uploadId,
      }),
    );

    await prisma.video.update({
      where: { id: videoId },
      data: { status: "FAILED" },
    });

    return NextResponse.json({ videoId, status: "FAILED" });
  }

  // Complete multipart upload
  const { parts, thumbnailR2Key } = body;

  if (!parts || !Array.isArray(parts) || !thumbnailR2Key) {
    return NextResponse.json(
      { error: "Missing parts array or thumbnailR2Key" },
      { status: 400 },
    );
  }

  // Verify ownership
  const video = await prisma.video.findFirst({
    where: {
      id: videoId,
      uploaderId: userId,
      status: "UPLOADING",
    },
    select: { id: true, slug: true },
  });

  if (!video) {
    return NextResponse.json(
      { error: "No in-progress upload found" },
      { status: 404 },
    );
  }

  // Complete S3 multipart upload
  await r2Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );

  // Transition to READY
  await prisma.video.update({
    where: { id: videoId },
    data: {
      status: "READY",
      thumbnailR2Key,
      uploadId: null,
    },
  });

  return NextResponse.json({
    videoId,
    slug: video.slug,
    status: "READY",
  });
}

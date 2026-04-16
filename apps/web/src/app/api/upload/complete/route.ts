import { NextRequest, NextResponse } from "next/server";
import { requireDesktopAuth } from "@/lib/desktop-auth";
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
  const auth = await requireDesktopAuth(req);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

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
    try {
      await r2Client.send(
        new AbortMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: r2Key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      await prisma.video.update({
        where: { id: videoId },
        data: { status: "FAILED" },
      });
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `R2 abort failed: ${detail.slice(0, 200)}` },
        { status: 502 },
      );
    }

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
  try {
    await r2Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET,
        Key: r2Key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (err) {
    await prisma.video.update({
      where: { id: videoId },
      data: { status: "FAILED" },
    });
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `R2 complete failed: ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  }

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

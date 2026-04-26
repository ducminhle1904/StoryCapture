import { NextRequest, NextResponse } from "next/server";
import { requireDesktopAuth } from "@/lib/desktop-auth";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slugify";
import {
  r2Client,
  R2_BUCKET,
  CreateMultipartUploadCommand,
} from "@/lib/r2";

/**
 * POST /api/upload/initiate
 *
 * Thin REST wrapper for desktop Rust client.
 * Validates desktop JWT from Authorization header.
 * Creates a multipart upload in R2 + a Video DB record.
 */
export async function POST(req: NextRequest) {
  // Validate desktop JWT
  const auth = await requireDesktopAuth(req);
  if (!auth.ok) return auth.response;
  const userId = auth.userId;

  const body = await req.json();
  const {
    fileName,
    fileSizeBytes,
    contentType = "video/mp4",
    workspaceId,
    projectName,
    storySource,
    sceneBoundaries,
  } = body;

  if (!fileName || !fileSizeBytes || !workspaceId || !projectName) {
    return NextResponse.json(
      { error: "Missing required fields: fileName, fileSizeBytes, workspaceId, projectName" },
      { status: 400 },
    );
  }

  // Verify user has EDITOR or OWNER role
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: { userId, workspaceId },
    },
  });

  if (!membership || membership.role === "VIEWER") {
    return NextResponse.json(
      { error: "You need EDITOR or OWNER role to upload" },
      { status: 403 },
    );
  }

  // Generate R2 key
  const videoUuid = crypto.randomUUID();
  const key = `${workspaceId}/${videoUuid}/${fileName}`;

  // Create multipart upload with SSE-S3 encryption
  const { UploadId } = await r2Client.send(
    new CreateMultipartUploadCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType,
      ServerSideEncryption: "AES256",
    }),
  );

  if (!UploadId) {
    return NextResponse.json(
      { error: "Failed to initiate multipart upload" },
      { status: 500 },
    );
  }

  // Generate unique slug
  const baseSlug = slugify(projectName) || "video";
  let slug = baseSlug;
  let attempt = 0;
  while (true) {
    const existing = await prisma.video.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!existing) break;
    attempt++;
    slug = `${baseSlug}-${attempt}`;
  }

  // Create Video record
  const video = await prisma.video.create({
    data: {
      slug,
      r2Key: key,
      uploadId: UploadId,
      fileName,
      fileSizeBytes: BigInt(fileSizeBytes),
      status: "UPLOADING",
      projectName,
      workspaceId,
      uploaderId: userId,
      storySource: storySource ?? null,
      sceneBoundaries: sceneBoundaries ?? [],
    },
  });

  return NextResponse.json({
    videoId: video.id,
    uploadId: UploadId,
    r2Key: key,
    slug,
  });
}

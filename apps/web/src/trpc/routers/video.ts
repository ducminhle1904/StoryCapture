import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure } from "../init";
import {
  r2Client,
  R2_BUCKET,
  createPresignedPartUrl,
  createPresignedGetUrl,
  createPresignedPutUrl,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@/lib/r2";

/**
 * Video CRUD + upload orchestration tRPC procedures.
 *
 * Upload flow:
 * 1. initiateUpload -> creates multipart upload + DB record (UPLOADING)
 * 2. getPartPresignedUrl -> returns presigned PUT URL per chunk
 * 3. completeUpload -> finalizes multipart + transitions to READY
 *
 * Threat mitigations:
 * - T-04-12: Every procedure requires auth (protectedProcedure)
 * - T-04-13: Presigned URLs are part-specific, time-limited (1h)
 * - T-04-14: R2 credentials never leave server
 * - T-04-16: SSE-S3 AES256 encryption on all objects (DIST-06)
 */

/** Generate a URL-friendly slug from a project name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const sceneBoundarySchema = z.object({
  sceneIndex: z.number(),
  label: z.string(),
  startTimeSec: z.number(),
});

export const videoRouter = router({
  /**
   * Initiate a multipart upload to R2.
   * Creates the S3 multipart upload + a Video DB record with status UPLOADING.
   */
  initiateUpload: protectedProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        fileSizeBytes: z.number().int().positive(),
        contentType: z.string().default("video/mp4"),
        workspaceId: z.string(),
        projectName: z.string().min(1).max(200),
        storySource: z.string().optional(),
        sceneBoundaries: z.array(sceneBoundarySchema).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify user has EDITOR or OWNER role in workspace
      const membership = await ctx.prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.user.id!,
            workspaceId: input.workspaceId,
          },
        },
      });

      if (!membership || membership.role === "VIEWER") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You need EDITOR or OWNER role to upload videos.",
        });
      }

      // Generate R2 key: {workspaceId}/{uuid}/{fileName}
      const videoUuid = crypto.randomUUID();
      const key = `${input.workspaceId}/${videoUuid}/${input.fileName}`;

      // Create multipart upload with SSE-S3 encryption (DIST-06)
      const { UploadId } = await r2Client.send(
        new CreateMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: key,
          ContentType: input.contentType,
          ServerSideEncryption: "AES256",
        }),
      );

      if (!UploadId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to initiate multipart upload — no UploadId returned.",
        });
      }

      // Generate unique slug from project name
      const baseSlug = slugify(input.projectName) || "video";
      let slug = baseSlug;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const existing = await ctx.prisma.video.findUnique({
          where: { slug },
          select: { id: true },
        });
        if (!existing) break;
        attempt++;
        slug = `${baseSlug}-${attempt}`;
      }

      // Create Video record
      const video = await ctx.prisma.video.create({
        data: {
          slug,
          r2Key: key,
          uploadId: UploadId,
          fileName: input.fileName,
          fileSizeBytes: BigInt(input.fileSizeBytes),
          status: "UPLOADING",
          projectName: input.projectName,
          workspaceId: input.workspaceId,
          uploaderId: ctx.user.id!,
          storySource: input.storySource,
          sceneBoundaries: input.sceneBoundaries ?? [],
        },
      });

      return { videoId: video.id, uploadId: UploadId, r2Key: key, slug };
    }),

  /**
   * Get a presigned PUT URL for a single part of a multipart upload.
   * Pitfall 2: partNumber must be 1-10000.
   */
  getPartPresignedUrl: protectedProcedure
    .input(
      z.object({
        r2Key: z.string(),
        uploadId: z.string(),
        partNumber: z.number().int().min(1).max(10000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify user owns the in-progress upload
      const video = await ctx.prisma.video.findFirst({
        where: {
          r2Key: input.r2Key,
          uploadId: input.uploadId,
          uploaderId: ctx.user.id!,
          status: "UPLOADING",
        },
        select: { id: true },
      });

      if (!video) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No in-progress upload found for this key.",
        });
      }

      const presignedUrl = await createPresignedPartUrl(
        R2_BUCKET,
        input.r2Key,
        input.uploadId,
        input.partNumber,
      );

      return { presignedUrl, partNumber: input.partNumber };
    }),

  /**
   * Complete a multipart upload. Transitions video to READY.
   * thumbnailR2Key is an explicit input parameter from the desktop.
   */
  completeUpload: protectedProcedure
    .input(
      z.object({
        videoId: z.string(),
        r2Key: z.string(),
        uploadId: z.string(),
        parts: z.array(
          z.object({
            PartNumber: z.number(),
            ETag: z.string(),
          }),
        ),
        thumbnailR2Key: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const video = await ctx.prisma.video.findFirst({
        where: {
          id: input.videoId,
          uploaderId: ctx.user.id!,
          status: "UPLOADING",
        },
        select: { id: true, slug: true },
      });

      if (!video) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No in-progress upload found.",
        });
      }

      // Complete the S3 multipart upload
      await r2Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: input.r2Key,
          UploadId: input.uploadId,
          MultipartUpload: { Parts: input.parts },
        }),
      );

      // Transition to READY
      await ctx.prisma.video.update({
        where: { id: input.videoId },
        data: {
          status: "READY",
          thumbnailR2Key: input.thumbnailR2Key,
          uploadId: null, // Clear multipart upload ID
        },
      });

      return { videoId: input.videoId, slug: video.slug, status: "READY" as const };
    }),

  /**
   * Abort a multipart upload. Transitions video to FAILED.
   */
  abortUpload: protectedProcedure
    .input(
      z.object({
        videoId: z.string(),
        r2Key: z.string(),
        uploadId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Abort the S3 multipart upload
      await r2Client.send(
        new AbortMultipartUploadCommand({
          Bucket: R2_BUCKET,
          Key: input.r2Key,
          UploadId: input.uploadId,
        }),
      );

      await ctx.prisma.video.update({
        where: { id: input.videoId },
        data: { status: "FAILED" },
      });

      return { videoId: input.videoId, status: "FAILED" as const };
    }),

  /**
   * Get a presigned PUT URL for thumbnail upload (single object, not multipart).
   */
  getThumbnailPresignedUrl: protectedProcedure
    .input(
      z.object({
        r2Key: z.string(), // The video's r2Key — thumbnail key derived from it
      }),
    )
    .mutation(async ({ input }) => {
      const thumbnailKey = input.r2Key.replace(/\.[^.]+$/, "-thumb.jpg");
      const presignedUrl = await createPresignedPutUrl(
        R2_BUCKET,
        thumbnailKey,
        "image/jpeg",
      );
      return { presignedUrl, thumbnailR2Key: thumbnailKey };
    }),

  /**
   * List videos in a workspace.
   */
  list: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      // Verify membership
      const membership = await ctx.prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.user.id!,
            workspaceId: input.workspaceId,
          },
        },
      });

      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a member of this workspace.",
        });
      }

      const videos = await ctx.prisma.video.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          slug: true,
          projectName: true,
          fileName: true,
          fileSizeBytes: true,
          status: true,
          isPublic: true,
          thumbnailR2Key: true,
          createdAt: true,
        },
      });

      // Generate presigned GET URLs for thumbnails
      const videosWithThumbnails = await Promise.all(
        videos.map(async (video) => ({
          ...video,
          // Serialize BigInt to number for JSON
          fileSizeBytes: Number(video.fileSizeBytes),
          thumbnailUrl: video.thumbnailR2Key
            ? await createPresignedGetUrl(R2_BUCKET, video.thumbnailR2Key)
            : null,
        })),
      );

      return videosWithThumbnails;
    }),

  /**
   * Get a video by slug (public query for viewer pages).
   * D-02: Private by default; public data only for READY videos.
   */
  getBySlug: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ ctx, input }) => {
      const video = await ctx.prisma.video.findUnique({
        where: { slug: input.slug },
        select: {
          id: true,
          slug: true,
          projectName: true,
          status: true,
          isPublic: true,
          storySource: true,
          sceneBoundaries: true,
          r2Key: true,
          thumbnailR2Key: true,
          createdAt: true,
        },
      });

      if (!video || video.status !== "READY") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Video not found.",
        });
      }

      // Generate presigned GET URLs (works for both public + private/unlisted)
      const videoUrl = await createPresignedGetUrl(R2_BUCKET, video.r2Key);
      const thumbnailUrl = video.thumbnailR2Key
        ? await createPresignedGetUrl(R2_BUCKET, video.thumbnailR2Key)
        : null;

      return {
        id: video.id,
        slug: video.slug,
        projectName: video.projectName,
        isPublic: video.isPublic,
        storySource: video.storySource,
        sceneBoundaries: video.sceneBoundaries,
        videoUrl,
        thumbnailUrl,
        createdAt: video.createdAt,
      };
    }),
});

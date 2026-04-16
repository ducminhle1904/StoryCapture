/**
 * Sync tRPC router — desktop-to-web metadata push and live SSE subscriptions.
 *
 * Procedures:
 *   pushMetadata (mutation) — upsert project metadata from desktop
 *   updateRecordingStatus (mutation) — update recording status (called frequently)
 *   onRecordingStatus (subscription) — SSE stream of recording status changes
 *   onProjectUpdates (subscription) — SSE stream of project metadata changes
 *   listProjects (query) — list all synced projects for a workspace
 *
 * Auth:
 *   Mutations: protectedProcedure (session or JWT via Authorization header)
 *   Subscriptions: publicProcedure with JWT verified from input token (Pitfall 7:
 *     SSE can't send custom headers via EventSource, so JWT goes in input)
 *
 * Threat mitigations:
 *   T-04-30 (Spoofing): JWT verified on subscription start; 15-min expiry
 *   T-04-31 (Tampering): JWT auth + workspace membership check; last-write-wins
 *   T-04-33 (DoS): 30s keepalive ping; Vercel 60s timeout
 */

import { TRPCError } from "@trpc/server";
import { tracked } from "@trpc/server";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { EventEmitter, on } from "node:events";
import { router, publicProcedure, protectedProcedure } from "../init";
import { verifyJwt } from "@/lib/jwt";
import { requireWorkspaceMember } from "../lib/guards";

// ── Sync event emitter (in-memory, per-process) ──

const syncEmitter = new EventEmitter();
syncEmitter.setMaxListeners(100); // allow many concurrent SSE subscribers

let eventCounter = 0;
function nextEventId(): string {
  return `${Date.now()}-${++eventCounter}`;
}

// ── Shared enums ──

export const recordingStatusEnum = z.enum([
  "idle",
  "recording",
  "processing",
  "complete",
  "error",
]);

/** Recording status type for frontend use. */
export type RecordingStatus = z.infer<typeof recordingStatusEnum>;

// ── Input schemas ──

const pushMetadataInput = z.object({
  desktopId: z.string(),
  workspaceId: z.string(),
  projectName: z.string(),
  storySource: z.string().optional(),
  recordingStatus: recordingStatusEnum.optional(),
});

const updateRecordingStatusInput = z.object({
  desktopId: z.string(),
  workspaceId: z.string(),
  status: recordingStatusEnum,
});

const sseSubscriptionInput = z.object({
  workspaceId: z.string(),
  token: z.string(),
  lastEventId: z.string().nullish(),
});

// ── Helper: verify JWT + workspace membership ──

async function verifySubscriber(
  token: string,
  workspaceId: string,
  prisma: PrismaClient,
) {
  const { userId } = await verifyJwt(token).catch(() => {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or expired SSE token",
    });
  });

  await requireWorkspaceMember(prisma, userId, workspaceId);

  return { userId };
}

// ── Router ──

export const syncRouter = router({
  /**
   * Push project metadata from desktop. Upserts SyncedProject.
   * Desktop is source of truth per D-07; last-write-wins.
   */
  pushMetadata: protectedProcedure
    .input(pushMetadataInput)
    .mutation(async ({ ctx, input }) => {
      // Verify workspace membership
      await requireWorkspaceMember(ctx.prisma, ctx.user.id!, input.workspaceId);

      const synced = await ctx.prisma.syncedProject.upsert({
        where: {
          desktopId_workspaceId: {
            desktopId: input.desktopId,
            workspaceId: input.workspaceId,
          },
        },
        update: {
          projectName: input.projectName,
          ...(input.storySource !== undefined && {
            storySource: input.storySource,
          }),
          ...(input.recordingStatus !== undefined && {
            recordingStatus: input.recordingStatus,
          }),
          lastSyncedAt: new Date(),
        },
        create: {
          desktopId: input.desktopId,
          workspaceId: input.workspaceId,
          projectName: input.projectName,
          storySource: input.storySource ?? null,
          recordingStatus: input.recordingStatus ?? "idle",
        },
      });

      // Emit events for SSE subscribers
      const eventId = nextEventId();
      syncEmitter.emit(`sync:${input.workspaceId}`, {
        id: eventId,
        type: "project_update",
        desktopId: input.desktopId,
        projectName: input.projectName,
        storySource: input.storySource,
        recordingStatus: synced.recordingStatus,
        lastSyncedAt: synced.lastSyncedAt.toISOString(),
      });

      if (input.recordingStatus !== undefined) {
        syncEmitter.emit(`recording:${input.workspaceId}`, {
          id: eventId,
          desktopId: input.desktopId,
          status: input.recordingStatus,
          projectName: input.projectName,
        });
      }

      return { synced: true, lastSyncedAt: synced.lastSyncedAt };
    }),

  /**
   * Update recording status. Called frequently during recording (every step change).
   */
  updateRecordingStatus: protectedProcedure
    .input(updateRecordingStatusInput)
    .mutation(async ({ ctx, input }) => {
      await requireWorkspaceMember(ctx.prisma, ctx.user.id!, input.workspaceId);

      await ctx.prisma.syncedProject.updateMany({
        where: {
          desktopId: input.desktopId,
          workspaceId: input.workspaceId,
        },
        data: {
          recordingStatus: input.status,
          lastSyncedAt: new Date(),
        },
      });

      const eventId = nextEventId();
      syncEmitter.emit(`recording:${input.workspaceId}`, {
        id: eventId,
        desktopId: input.desktopId,
        status: input.status,
        projectName: undefined, // caller may not have project name
      });

      return { updated: true };
    }),

  /**
   * SSE subscription: live recording status updates.
   * JWT auth via input token (Pitfall 7). tracked() for reconnection.
   * 30-second keepalive ping per RESEARCH.md SSE gotcha mitigation.
   */
  onRecordingStatus: publicProcedure
    .input(sseSubscriptionInput)
    .subscription(async function* (opts) {
      // Verify JWT + workspace membership
      await verifySubscriber(
        opts.input.token,
        opts.input.workspaceId,
        opts.ctx.prisma,
      );

      const eventName = `recording:${opts.input.workspaceId}`;

      // Set up keepalive ping every 30 seconds (T-04-33)
      const keepaliveInterval = setInterval(() => {
        syncEmitter.emit(eventName, {
          id: nextEventId(),
          desktopId: "__keepalive__",
          status: "ping",
        });
      }, 30_000);

      try {
        for await (const [data] of on(syncEmitter, eventName, {
          signal: opts.signal,
        })) {
          const event = data as {
            id: string;
            desktopId: string;
            status: string;
            projectName?: string;
          };

          yield tracked(event.id, {
            desktopId: event.desktopId,
            status: event.status,
            projectName: event.projectName,
          });
        }
      } finally {
        clearInterval(keepaliveInterval);
      }
    }),

  /**
   * SSE subscription: project metadata updates (name, story source, status).
   * JWT auth via input token. tracked() for reconnection.
   */
  onProjectUpdates: publicProcedure
    .input(sseSubscriptionInput)
    .subscription(async function* (opts) {
      await verifySubscriber(
        opts.input.token,
        opts.input.workspaceId,
        opts.ctx.prisma,
      );

      const eventName = `sync:${opts.input.workspaceId}`;

      // Keepalive ping every 30 seconds
      const keepaliveInterval = setInterval(() => {
        syncEmitter.emit(eventName, {
          id: nextEventId(),
          type: "keepalive",
          desktopId: "__keepalive__",
          projectName: "",
          lastSyncedAt: new Date().toISOString(),
        });
      }, 30_000);

      try {
        for await (const [data] of on(syncEmitter, eventName, {
          signal: opts.signal,
        })) {
          const event = data as {
            id: string;
            type: string;
            desktopId: string;
            projectName: string;
            storySource?: string;
            recordingStatus?: string;
            lastSyncedAt: string;
          };

          yield tracked(event.id, {
            type: event.type,
            desktopId: event.desktopId,
            projectName: event.projectName,
            storySource: event.storySource,
            recordingStatus: event.recordingStatus,
            lastSyncedAt: event.lastSyncedAt,
          });
        }
      } finally {
        clearInterval(keepaliveInterval);
      }
    }),

  /**
   * List all synced projects for a workspace. Polling fallback for SSE.
   */
  listProjects: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ ctx, input }) => {
      await requireWorkspaceMember(ctx.prisma, ctx.user.id!, input.workspaceId);

      const projects = await ctx.prisma.syncedProject.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: { lastSyncedAt: "desc" },
      });

      return projects.map((p) => ({
        id: p.id,
        desktopId: p.desktopId,
        projectName: p.projectName,
        storySource: p.storySource,
        recordingStatus: p.recordingStatus,
        lastSyncedAt: p.lastSyncedAt.toISOString(),
      }));
    }),
});

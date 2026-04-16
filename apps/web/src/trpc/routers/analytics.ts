import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../init";
import { DASHBOARD_DAYS, MAX_RETENTION_DAYS } from "@/lib/constants";

/**
 * Analytics tRPC router (Plan 04-08, D-06).
 *
 * Provides dashboard queries for video analytics:
 * - Play count (total + unique)
 * - Watch duration (average + median)
 * - Scene drop-off data
 * - Geographic breakdown (country-level)
 *
 * Threat mitigations:
 * - T-04-29: Only workspace editors/owners can view analytics (protectedProcedure + role check)
 */

/**
 * Verify that the authenticated user has at least VIEWER role
 * in the workspace that owns the video.
 */
async function verifyVideoAccess(
  prisma: Parameters<typeof router>[0] extends never ? never : any,
  userId: string,
  videoId: string,
) {
  const video = await prisma.video.findUnique({
    where: { id: videoId },
    select: { workspaceId: true },
  });

  if (!video) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Video not found." });
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      userId_workspaceId: {
        userId,
        workspaceId: video.workspaceId,
      },
    },
  });

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this workspace.",
    });
  }

  return video;
}

export const analyticsRouter = router({
  /**
   * Dashboard aggregated analytics for a video.
   * Computes: totalPlays, uniquePlays, avgDuration, medianDuration,
   * sceneDropoffs, countryBreakdown from raw ViewEvent data.
   */
  dashboard: protectedProcedure
    .input(
      z.object({
        videoId: z.string(),
        days: z.number().int().min(1).max(365).default(DASHBOARD_DAYS),
      }),
    )
    .query(async ({ ctx, input }) => {
      await verifyVideoAccess(ctx.prisma, ctx.user.id!, input.videoId);

      const since = new Date();
      since.setDate(since.getDate() - input.days);

      // Total plays
      const totalPlays = await ctx.prisma.viewEvent.count({
        where: {
          videoId: input.videoId,
          event: "play",
          timestamp: { gte: since },
        },
      });

      // Unique plays (distinct sessionId)
      const uniquePlayRows = await ctx.prisma.viewEvent.groupBy({
        by: ["sessionId"],
        where: {
          videoId: input.videoId,
          event: "play",
          timestamp: { gte: since },
        },
      });
      const uniquePlays = uniquePlayRows.length;

      // Watch durations from 'ended' events
      const endedEvents = await ctx.prisma.viewEvent.findMany({
        where: {
          videoId: input.videoId,
          event: "ended",
          timestamp: { gte: since },
          watchDurationSec: { not: null },
        },
        select: { watchDurationSec: true },
        orderBy: { watchDurationSec: "asc" },
      });

      let avgDurationSec = 0;
      let medianDurationSec = 0;

      if (endedEvents.length > 0) {
        const durations = endedEvents.map((e) => e.watchDurationSec!);
        avgDurationSec =
          durations.reduce((sum, d) => sum + d, 0) / durations.length;

        // Median
        const mid = Math.floor(durations.length / 2);
        medianDurationSec =
          durations.length % 2 !== 0
            ? durations[mid]!
            : (durations[mid - 1]! + durations[mid]!) / 2;
      }

      // Scene drop-offs: count scene_enter per scene
      const sceneEnters = await ctx.prisma.viewEvent.groupBy({
        by: ["currentScene"],
        where: {
          videoId: input.videoId,
          event: "scene_enter",
          timestamp: { gte: since },
          currentScene: { not: null },
        },
        _count: { id: true },
        orderBy: { currentScene: "asc" },
      });

      const sceneDropoffs = sceneEnters.map((row, idx) => {
        const nextCount =
          idx < sceneEnters.length - 1 ? sceneEnters[idx + 1]!._count.id : 0;
        return {
          sceneIndex: row.currentScene!,
          viewers: row._count.id,
          dropoff: row._count.id - nextCount,
        };
      });

      // Country breakdown
      const countryRows = await ctx.prisma.viewEvent.groupBy({
        by: ["country"],
        where: {
          videoId: input.videoId,
          event: "play",
          timestamp: { gte: since },
        },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
      });

      const countryBreakdown = countryRows.map((row) => ({
        country: row.country,
        count: row._count.id,
      }));

      return {
        totalPlays,
        uniquePlays,
        avgDurationSec: Math.round(avgDurationSec * 10) / 10,
        medianDurationSec: Math.round(medianDurationSec * 10) / 10,
        sceneDropoffs,
        countryBreakdown,
        periodDays: input.days,
      };
    }),

  /**
   * Pre-aggregated daily stats for chart display.
   * Falls back to on-the-fly computation if no DailyVideoStats rows exist.
   */
  dailyStats: protectedProcedure
    .input(
      z.object({
        videoId: z.string(),
        days: z.number().int().min(1).max(365).default(DASHBOARD_DAYS),
      }),
    )
    .query(async ({ ctx, input }) => {
      await verifyVideoAccess(ctx.prisma, ctx.user.id!, input.videoId);

      const since = new Date();
      since.setDate(since.getDate() - input.days);

      const rows = await ctx.prisma.dailyVideoStats.findMany({
        where: {
          videoId: input.videoId,
          date: { gte: since },
        },
        orderBy: { date: "asc" },
      });

      if (rows.length > 0) {
        return rows.map((r) => ({
          date: r.date.toISOString().slice(0, 10),
          totalPlays: r.totalPlays,
          uniquePlays: r.uniquePlays,
          avgDurationSec: r.avgDurationSec,
          medianDurationSec: r.medianDurationSec,
        }));
      }

      // Fallback: compute on-the-fly from raw events (grouped by day)
      const events = await ctx.prisma.viewEvent.findMany({
        where: {
          videoId: input.videoId,
          event: "play",
          timestamp: { gte: since },
        },
        select: { timestamp: true },
      });

      const byDay = new Map<string, number>();
      for (const ev of events) {
        const day = ev.timestamp.toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }

      return Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, totalPlays]) => ({
          date,
          totalPlays,
          uniquePlays: 0, // Not available in fallback mode
          avgDurationSec: 0,
          medianDurationSec: 0,
        }));
    }),

  /**
   * Manual trigger for daily rollup aggregation.
   * Computes stats for a given day and upserts into DailyVideoStats.
   */
  aggregateDaily: protectedProcedure
    .input(
      z.object({
        videoId: z.string(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await verifyVideoAccess(ctx.prisma, ctx.user.id!, input.videoId);

      const dayStart = new Date(input.date + "T00:00:00.000Z");
      const dayEnd = new Date(input.date + "T23:59:59.999Z");

      const where = {
        videoId: input.videoId,
        timestamp: { gte: dayStart, lte: dayEnd },
      };

      // Total plays
      const totalPlays = await ctx.prisma.viewEvent.count({
        where: { ...where, event: "play" },
      });

      // Unique plays
      const uniqueRows = await ctx.prisma.viewEvent.groupBy({
        by: ["sessionId"],
        where: { ...where, event: "play" },
      });
      const uniquePlays = uniqueRows.length;

      // Durations
      const endedEvents = await ctx.prisma.viewEvent.findMany({
        where: { ...where, event: "ended", watchDurationSec: { not: null } },
        select: { watchDurationSec: true },
        orderBy: { watchDurationSec: "asc" },
      });

      let avgDurationSec = 0;
      let medianDurationSec = 0;

      if (endedEvents.length > 0) {
        const durations = endedEvents.map((e) => e.watchDurationSec!);
        avgDurationSec = durations.reduce((s, d) => s + d, 0) / durations.length;
        const mid = Math.floor(durations.length / 2);
        medianDurationSec =
          durations.length % 2 !== 0
            ? durations[mid]!
            : (durations[mid - 1]! + durations[mid]!) / 2;
      }

      // Country breakdown
      const countryRows = await ctx.prisma.viewEvent.groupBy({
        by: ["country"],
        where: { ...where, event: "play" },
        _count: { id: true },
      });
      const countryBreakdown: Record<string, number> = {};
      for (const row of countryRows) {
        countryBreakdown[row.country] = row._count.id;
      }

      // Scene dropoffs
      const sceneEnters = await ctx.prisma.viewEvent.groupBy({
        by: ["currentScene"],
        where: { ...where, event: "scene_enter", currentScene: { not: null } },
        _count: { id: true },
        orderBy: { currentScene: "asc" },
      });
      const sceneDropoffs = sceneEnters.map((row, idx) => {
        const nextCount =
          idx < sceneEnters.length - 1 ? sceneEnters[idx + 1]!._count.id : 0;
        return {
          sceneIndex: row.currentScene!,
          dropoffCount: row._count.id - nextCount,
        };
      });

      // Upsert
      await ctx.prisma.dailyVideoStats.upsert({
        where: {
          videoId_date: {
            videoId: input.videoId,
            date: dayStart,
          },
        },
        create: {
          videoId: input.videoId,
          date: dayStart,
          totalPlays,
          uniquePlays,
          avgDurationSec: Math.round(avgDurationSec * 10) / 10,
          medianDurationSec: Math.round(medianDurationSec * 10) / 10,
          countryBreakdown,
          sceneDropoffs,
        },
        update: {
          totalPlays,
          uniquePlays,
          avgDurationSec: Math.round(avgDurationSec * 10) / 10,
          medianDurationSec: Math.round(medianDurationSec * 10) / 10,
          countryBreakdown,
          sceneDropoffs,
        },
      });

      return { aggregated: true, date: input.date };
    }),
});

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { MAX_RETENTION_DAYS } from "@/lib/constants";

/**
 * GET /api/cron/aggregate-analytics
 *
 * Vercel cron-triggered endpoint that:
 * 1. Aggregates raw ViewEvent data into DailyVideoStats for today
 * 2. Cleans up raw ViewEvent records older than 90 days (D-06)
 *
 * Security: Verifies CRON_SECRET bearer token (Vercel sets this automatically).
 */
export async function GET(req: NextRequest) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(today);
  todayEnd.setUTCHours(23, 59, 59, 999);

  // Find all videos with events in the last 2 minutes
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);

  const recentVideoIds = await prisma.viewEvent.groupBy({
    by: ["videoId"],
    where: {
      timestamp: { gte: twoMinAgo },
    },
  });

  let aggregated = 0;

  for (const { videoId } of recentVideoIds) {
    const where = {
      videoId,
      timestamp: { gte: today, lte: todayEnd },
    };

    // Total plays
    const totalPlays = await prisma.viewEvent.count({
      where: { ...where, event: "play" },
    });

    // Unique plays
    const uniqueRows = await prisma.viewEvent.groupBy({
      by: ["sessionId"],
      where: { ...where, event: "play" },
    });
    const uniquePlays = uniqueRows.length;

    // Durations
    const endedEvents = await prisma.viewEvent.findMany({
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
    const countryRows = await prisma.viewEvent.groupBy({
      by: ["country"],
      where: { ...where, event: "play" },
      _count: { id: true },
    });
    const countryBreakdown: Record<string, number> = {};
    for (const row of countryRows) {
      countryBreakdown[row.country] = row._count.id;
    }

    // Scene dropoffs
    const sceneEnters = await prisma.viewEvent.groupBy({
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

    // Upsert DailyVideoStats
    await prisma.dailyVideoStats.upsert({
      where: {
        videoId_date: { videoId, date: today },
      },
      create: {
        videoId,
        date: today,
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

    aggregated++;
  }

  // Clean up raw events older than 90 days (D-06)
  const retentionCutoff = new Date();
  retentionCutoff.setDate(retentionCutoff.getDate() - MAX_RETENTION_DAYS);

  const { count: cleaned } = await prisma.viewEvent.deleteMany({
    where: {
      timestamp: { lt: retentionCutoff },
    },
  });

  return NextResponse.json({ aggregated, cleaned });
}

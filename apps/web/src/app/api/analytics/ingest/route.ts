import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCountry } from "@/lib/geo";
import { ANALYTICS_EVENTS, type AnalyticsEventType } from "@/lib/constants";

/**
 * POST /api/analytics/ingest
 *
 * Public endpoint for anonymous viewers to submit batched video analytics events.
 * No auth required — viewers are anonymous (T-04-26: rate limited, validated).
 * Accepts an array of 1-50 events per request so viewers can batch client-side
 * (e.g. flush every 5-10 events or on page unload via sendBeacon).
 *
 * Threat mitigations:
 * - T-04-26: Rate limiting (10 req/sec per IP), validates videoId exists, validates event type enum
 * - T-04-27: No PII stored; country-level only via GeoLite2 (D-06)
 */

// ─── Rate Limiter (T-04-26) ───
// NOTE: Process-local Map — on serverless (Vercel), each instance has its own map
// and cold starts reset it. This is acceptable for v1; a Redis/Upstash sliding
// window is a v2 upgrade path.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per window per IP
const RATE_WINDOW_MS = 1000;

function checkRateLimit(ip: string): { limited: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  // Inline cleanup: evict stale entries during each request instead of
  // relying on setInterval (which never fires in serverless).
  if (rateLimitMap.size > 1000) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt + 60_000) {
        rateLimitMap.delete(key);
      }
    }
  }

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { limited: false, remaining: RATE_LIMIT - 1 };
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return { limited: true, remaining: 0 };
  }

  return { limited: false, remaining: RATE_LIMIT - entry.count };
}

interface IngestEvent {
  videoId: string;
  event: AnalyticsEventType;
  sessionId: string;
  currentScene?: number;
  watchDurationSec?: number;
}

interface IngestPayload {
  events: IngestEvent[];
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";

  // T-04-26: Rate limit with response headers
  const { limited, remaining } = checkRateLimit(ip);
  const rateLimitHeaders = {
    "X-RateLimit-Limit": String(RATE_LIMIT),
    "X-RateLimit-Remaining": String(remaining),
  };

  if (limited) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: rateLimitHeaders },
    );
  }

  let body: IngestPayload;
  try {
    const raw = await req.json();
    // Accept both { events: [...] } batch format and legacy single-event { videoId, event, ... }
    if (Array.isArray(raw?.events)) {
      body = raw as IngestPayload;
    } else if (raw?.videoId && raw?.event) {
      body = { events: [raw as IngestEvent] };
    } else {
      return NextResponse.json(
        { error: "Expected { events: [...] } array or a single event object" },
        { status: 400, headers: rateLimitHeaders },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: rateLimitHeaders },
    );
  }

  if (body.events.length === 0 || body.events.length > 50) {
    return NextResponse.json(
      { error: "events array must contain 1-50 items" },
      { status: 400, headers: rateLimitHeaders },
    );
  }

  // Validate all events before inserting any
  const videoIdCache = new Map<string, boolean>();

  for (const evt of body.events) {
    // Validate event type (T-04-26)
    if (!evt.event || !(ANALYTICS_EVENTS as readonly string[]).includes(evt.event)) {
      return NextResponse.json(
        { error: `Invalid event type. Must be one of: ${ANALYTICS_EVENTS.join(", ")}` },
        { status: 400, headers: rateLimitHeaders },
      );
    }

    if (!evt.videoId || typeof evt.videoId !== "string") {
      return NextResponse.json(
        { error: "videoId is required for each event" },
        { status: 400, headers: rateLimitHeaders },
      );
    }

    if (!evt.sessionId || typeof evt.sessionId !== "string") {
      return NextResponse.json(
        { error: "sessionId is required for each event" },
        { status: 400, headers: rateLimitHeaders },
      );
    }

    // T-04-26: Validate videoId exists (deduplicated across batch)
    if (!videoIdCache.has(evt.videoId)) {
      const video = await prisma.video.findUnique({
        where: { id: evt.videoId },
        select: { id: true },
      });
      videoIdCache.set(evt.videoId, !!video);
    }

    if (!videoIdCache.get(evt.videoId)) {
      return NextResponse.json(
        { error: `Video not found: ${evt.videoId}` },
        { status: 404, headers: rateLimitHeaders },
      );
    }
  }

  // Resolve country from IP (D-06: country-level only, T-04-27: no PII)
  const country = await getCountry(ip);

  // Batch insert all events with createMany (single INSERT instead of N)
  await prisma.viewEvent.createMany({
    data: body.events.map((evt) => ({
      videoId: evt.videoId,
      event: evt.event,
      sessionId: evt.sessionId,
      country,
      currentScene: evt.currentScene ?? null,
      watchDurationSec: evt.watchDurationSec ?? null,
    })),
  });

  return NextResponse.json(
    { ok: true, ingested: body.events.length },
    { headers: rateLimitHeaders },
  );
}

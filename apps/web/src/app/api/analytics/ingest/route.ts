import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCountry } from "@/lib/geo";
import { ANALYTICS_EVENTS, type AnalyticsEventType } from "@/lib/constants";

/**
 * POST /api/analytics/ingest
 *
 * Public endpoint for anonymous viewers to submit video analytics events.
 * No auth required — viewers are anonymous (T-04-26: rate limited, validated).
 *
 * Threat mitigations:
 * - T-04-26: Rate limiting (10 events/sec per IP), validates videoId exists, validates event type enum
 * - T-04-27: No PII stored; country-level only via GeoLite2 (D-06)
 */

// Simple in-memory rate limiter (T-04-26)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // events per second per IP
const RATE_WINDOW_MS = 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return true;
  }

  return false;
}

// Periodically clean stale entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt + 60_000) {
      rateLimitMap.delete(key);
    }
  }
}, 60_000);

interface IngestPayload {
  videoId: string;
  event: AnalyticsEventType;
  sessionId: string;
  currentScene?: number;
  watchDurationSec?: number;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "unknown";

  // T-04-26: Rate limit
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: IngestPayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate event type (T-04-26)
  if (!body.event || !(ANALYTICS_EVENTS as readonly string[]).includes(body.event)) {
    return NextResponse.json(
      { error: `Invalid event type. Must be one of: ${ANALYTICS_EVENTS.join(", ")}` },
      { status: 400 },
    );
  }

  if (!body.videoId || typeof body.videoId !== "string") {
    return NextResponse.json({ error: "videoId is required" }, { status: 400 });
  }

  if (!body.sessionId || typeof body.sessionId !== "string") {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  // T-04-26: Validate videoId exists
  const video = await prisma.video.findUnique({
    where: { id: body.videoId },
    select: { id: true },
  });

  if (!video) {
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  }

  // Resolve country from IP (D-06: country-level only, T-04-27: no PII)
  const country = await getCountry(ip);

  // Insert ViewEvent
  await prisma.viewEvent.create({
    data: {
      videoId: body.videoId,
      event: body.event,
      sessionId: body.sessionId,
      country,
      currentScene: body.currentScene ?? null,
      watchDurationSec: body.watchDurationSec ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}

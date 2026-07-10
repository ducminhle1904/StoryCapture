import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_MAX_AGE, SESSION_COOKIE_NAME } from "@/lib/constants";

/**
 * GET /api/analytics/session
 *
 * Returns or creates a GDPR-safe session ID cookie for anonymous viewer tracking.
 * httpOnly, secure, SameSite=Lax, 30-day expiry. Value is a random UUID —
 * no PII, no fingerprinting.
 */
export async function GET() {
  const cookieStore = await cookies();
  let sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }

  const response = NextResponse.json({ sessionId });

  // Always refresh the cookie to extend expiry
  response.cookies.set(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE,
    path: "/",
  });

  return response;
}

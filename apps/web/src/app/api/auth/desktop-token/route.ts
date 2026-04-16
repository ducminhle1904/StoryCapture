import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { mintDesktopToken } from "@/lib/jwt";

/**
 * Desktop token exchange endpoint.
 *
 * POST /api/auth/desktop-token
 * Body: { sessionToken: string }
 *
 * Flow:
 * 1. Desktop completes OAuth via localhost redirect (tauri-plugin-oauth)
 * 2. Desktop sends the session token cookie value to this endpoint
 * 3. Server validates the session exists in the database (revocable)
 * 4. Returns a long-lived desktop API token (30 days, JWT)
 *
 * The desktop stores this token in the OS keychain and uses it
 * to authenticate subsequent API calls and mint short-lived SSE JWTs.
 *
 * TODO: Add rate limiting in production deployment (e.g., Vercel Edge Config or upstash/ratelimit)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionToken } = body;

    if (!sessionToken || typeof sessionToken !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid sessionToken" },
        { status: 400 },
      );
    }

    // Validate session exists in database and hasn't expired (T-04-08)
    const session = await prisma.session.findUnique({
      where: { sessionToken },
      include: { user: true },
    });

    if (!session) {
      return NextResponse.json(
        { error: "Invalid session token" },
        { status: 401 },
      );
    }

    if (session.expires < new Date()) {
      return NextResponse.json(
        { error: "Session has expired" },
        { status: 401 },
      );
    }

    // Mint a long-lived desktop API token
    const desktopToken = await mintDesktopToken(session.userId);

    return NextResponse.json({
      token: desktopToken,
      userId: session.userId,
      expiresIn: 30 * 24 * 60 * 60, // 30 days in seconds
    });
  } catch (error) {
    console.error("Desktop token exchange error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

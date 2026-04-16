import { auth } from "@/lib/auth";
import { mintJwt } from "@/lib/jwt";
import { NextResponse } from "next/server";

/**
 * Mint a short-lived SSE JWT (15 min) for authenticated web users.
 * Used by the RecordingStatus and ProjectMirror components to authenticate
 * SSE subscriptions (Pitfall 7: EventSource can't send custom headers,
 * so JWT is passed via subscription input).
 */
export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const token = await mintJwt(session.user.id);

  return NextResponse.json({ token });
}

import { type NextRequest, NextResponse } from "next/server";
import { verifyDesktopToken } from "@/lib/jwt";

type AuthResult = { ok: true; userId: string } | { ok: false; response: NextResponse };

/**
 * Validate desktop JWT from the Authorization header.
 * Returns `{ ok: true, userId }` on success, or `{ ok: false, response }` on failure.
 *
 * Usage in REST route handlers:
 * ```ts
 * const auth = await requireDesktopAuth(req);
 * if (!auth.ok) return auth.response;
 * const userId = auth.userId;
 * ```
 */
export async function requireDesktopAuth(req: NextRequest): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Missing authorization" }, { status: 401 }),
    };
  }

  try {
    const result = await verifyDesktopToken(authHeader.slice(7));
    return { ok: true, userId: result.userId };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid or expired token" }, { status: 401 }),
    };
  }
}

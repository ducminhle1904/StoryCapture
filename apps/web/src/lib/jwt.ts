import { SignJWT, jwtVerify } from "jose";

/**
 * JWT utilities for desktop auth tokens and SSE subscription auth.
 *
 * - Desktop tokens: long-lived (30 days) for persistent desktop-to-web auth
 * - SSE tokens: short-lived (15 min) for WebSocket/SSE subscription auth
 *
 * All tokens use HS256 signed with JWT_SECRET env var.
 */

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is not set");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Mint a long-lived desktop API token (30 days).
 * Used after OAuth callback to give the desktop app persistent auth.
 */
export async function mintDesktopToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, type: "desktop" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .setIssuer("storycapture-web")
    .setAudience("storycapture-desktop")
    .sign(getSecret());
}

/**
 * Verify a desktop API token. Returns the userId.
 */
export async function verifyDesktopToken(
  token: string,
): Promise<{ userId: string }> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: "storycapture-web",
    audience: "storycapture-desktop",
  });

  if (payload.type !== "desktop" || !payload.sub) {
    throw new Error("Invalid desktop token");
  }

  return { userId: payload.sub };
}

/**
 * Mint a short-lived JWT (15 min) for SSE subscriptions.
 * Desktop exchanges its long-lived token for this before opening SSE connections.
 */
export async function mintJwt(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, type: "sse" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .setIssuer("storycapture-web")
    .setAudience("storycapture-sse")
    .sign(getSecret());
}

/**
 * Verify a short-lived SSE JWT. Returns the userId.
 */
export async function verifyJwt(
  token: string,
): Promise<{ userId: string }> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: "storycapture-web",
    audience: "storycapture-sse",
  });

  if (payload.type !== "sse" || !payload.sub) {
    throw new Error("Invalid SSE token");
  }

  return { userId: payload.sub };
}

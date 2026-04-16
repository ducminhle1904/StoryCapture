import "server-only";

import { Reader, type ReaderModel } from "@maxmind/geoip2-node";
import { existsSync } from "fs";
import { join } from "path";

/**
 * MaxMind GeoLite2 country-level IP lookup (D-06).
 *
 * - Singleton reader, opened on first call
 * - Reads from public/geolite2/GeoLite2-Country.mmdb (gitignored, downloaded on deploy)
 * - Returns ISO 3166-1 alpha-2 country code or 'XX' for unknown/error
 * - No PII stored: only country code (T-04-27)
 */

const MMDB_PATH = join(process.cwd(), "public", "geolite2", "GeoLite2-Country.mmdb");

let readerInstance: ReaderModel | null = null;
let readerFailed = false;

async function getReader(): Promise<ReaderModel | null> {
  if (readerInstance) return readerInstance;
  if (readerFailed) return null;

  if (!existsSync(MMDB_PATH)) {
    console.warn(`[geo] GeoLite2 database not found at ${MMDB_PATH}. Country lookups will return 'XX'.`);
    readerFailed = true;
    return null;
  }

  try {
    readerInstance = await Reader.open(MMDB_PATH);
    return readerInstance;
  } catch (err) {
    console.error("[geo] Failed to open GeoLite2 database:", err);
    readerFailed = true;
    return null;
  }
}

/**
 * Resolve an IP address to an ISO 3166-1 alpha-2 country code.
 * Returns 'XX' if lookup fails or database is unavailable.
 */
export async function getCountry(ip: string | null): Promise<string> {
  if (!ip) return "XX";

  // Handle comma-separated x-forwarded-for (take first IP)
  const cleanIp = ip.split(",")[0]?.trim();
  if (!cleanIp) return "XX";

  // Skip private/localhost IPs
  if (
    cleanIp === "127.0.0.1" ||
    cleanIp === "::1" ||
    cleanIp.startsWith("10.") ||
    cleanIp.startsWith("192.168.") ||
    cleanIp.startsWith("172.")
  ) {
    return "XX";
  }

  const reader = await getReader();
  if (!reader) return "XX";

  try {
    const response = reader.country(cleanIp);
    return response.country?.isoCode ?? "XX";
  } catch {
    return "XX";
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import { readRecordingBundle } from "@storycapture/shared-types/recording-v2";

export const FAILED_RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function containedChild(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function cleanupExpiredFailedRecordingBundles(
  exportsDir: string,
  nowMs = Date.now(),
): Promise<string[]> {
  const entries = await fs.readdir(exportsDir, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".sc-recording")) continue;
    const bundlePath = path.join(exportsDir, entry.name);
    if (!containedChild(exportsDir, bundlePath)) continue;
    const manifestPath = path.join(bundlePath, "manifest.json");
    const manifest = await fs
      .readFile(manifestPath, "utf8")
      .then((text) => readRecordingBundle(JSON.parse(text) as unknown))
      .catch(() => null);
    if (!manifest || manifest.status !== "quality_failed") continue;
    const createdAtMs = Date.parse(manifest.created_at);
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs < FAILED_RECORDING_RETENTION_MS) {
      continue;
    }
    await fs.rm(bundlePath, { recursive: true, force: true });
    removed.push(bundlePath);
  }
  return removed;
}

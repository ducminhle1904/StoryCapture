import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { probeRecording, type RecordingProbeResult } from "./media-probe";
import { readRecordingBundleManifest } from "./recording-bundle";
import { recordEngineLog } from "./recording-observability";

type DiscoveryValidation =
  | { status: "unvalidated" }
  | { status: "valid" }
  | Extract<RecordingProbeResult, { status: "invalid" }>;

interface ProjectRecording {
  path: string;
  captured_at: number;
  size: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  container: string | null;
  validation: DiscoveryValidation;
  status?: "valid";
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
}

function emitDiscoveryResult(input: {
  requestId: string;
  startedAt: number;
  event: "recording.discovery.completed" | "recording.discovery.failed";
  reasonCode: string;
  details: Record<string, unknown>;
}): void {
  void recordEngineLog({
    level: input.event === "recording.discovery.failed" ? "warn" : "info",
    event: input.event,
    context: {
      request_id: input.requestId,
      phase: "recording_discovery",
      reason_code: input.reasonCode,
      duration_ms: Math.max(0, Date.now() - input.startedAt),
    },
    details: input.details,
  });
}

async function discoverBundleRecordings(exportsDir: string) {
  const takesDir = path.join(exportsDir, "takes");
  let entries: Dirent[];
  let readErrorCode: string | null = null;
  try {
    entries = await fs.readdir(takesDir, { withFileTypes: true });
  } catch (error) {
    entries = [];
    const code = errorCode(error);
    if (code !== "ENOENT") readErrorCode = code;
  }
  const candidates = entries.filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  const recordings = await Promise.all(
    candidates.map(async (entry) => {
      const root = path.join(takesDir, entry.name);
      const manifest = await readRecordingBundleManifest(root);
      if (!manifest || manifest.take_id !== entry.name || manifest.verdict !== "passed")
        return null;
      const videoArtifact = manifest.artifacts.find(
        (artifact) => artifact.kind === "video" && artifact.relative_path === "media/video.mp4",
      );
      if (!videoArtifact) return null;
      const file = path.join(root, "media", "video.mp4");
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.size !== videoArtifact.bytes) return null;
      const committedAt = Date.parse(manifest.committed_at);
      return {
        path: file,
        captured_at: Number.isFinite(committedAt) ? committedAt : stat.mtimeMs,
        size: stat.size,
        duration_ms: null,
        width: manifest.capture.output_width,
        height: manifest.capture.output_height,
        codec: null,
        container: null,
        validation: { status: "unvalidated" as const },
      };
    }),
  );
  return { candidates: candidates.length, recordings, readErrorCode };
}

export async function discoverProjectRecordings(
  exportsDir: string,
  probe: (filePath: string) => Promise<RecordingProbeResult> = probeRecording,
) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportsDir, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    emitDiscoveryResult({
      requestId,
      startedAt,
      event: code === "ENOENT" ? "recording.discovery.completed" : "recording.discovery.failed",
      reasonCode: code === "ENOENT" ? "exports_missing" : "exports_read_failed",
      details: {
        exports_present: false,
        bundle_candidates: 0,
        bundle_accepted: 0,
        legacy_candidates: 0,
        legacy_accepted: 0,
        returned_count: 0,
        latest_validation_status: "none",
        ...(code === "ENOENT" ? {} : { error_code: code }),
      },
    });
    return [];
  }
  const legacyCandidates = entries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp4"),
  );
  let bundleDiscovery: Awaited<ReturnType<typeof discoverBundleRecordings>>;
  let legacyRecordings: Array<ProjectRecording | null>;
  try {
    [bundleDiscovery, legacyRecordings] = await Promise.all([
      discoverBundleRecordings(exportsDir),
      Promise.all(
        legacyCandidates.map(async (entry) => {
          const file = path.join(exportsDir, entry.name);
          const stat = await fs.stat(file).catch(() => null);
          if (!stat?.isFile()) return null;
          return {
            path: file,
            captured_at: stat.mtimeMs,
            size: stat.size,
            duration_ms: null,
            width: null,
            height: null,
            codec: null,
            container: null,
            validation: { status: "unvalidated" as const },
          };
        }),
      ),
    ]);
  } catch (error) {
    emitDiscoveryResult({
      requestId,
      startedAt,
      event: "recording.discovery.failed",
      reasonCode: "discovery_failed",
      details: {
        exports_present: true,
        bundle_candidates: 0,
        bundle_accepted: 0,
        legacy_candidates: legacyCandidates.length,
        legacy_accepted: 0,
        returned_count: 0,
        latest_validation_status: "none",
        error_code: errorCode(error),
      },
    });
    throw error;
  }
  const bundleRecordings = bundleDiscovery.recordings;
  const seen = new Set<string>();
  const sorted = [...bundleRecordings, ...legacyRecordings]
    .filter((recording) => recording !== null)
    .filter((recording) => {
      const normalized = path.normalize(recording.path);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .sort((a, b) => b.captured_at - a.captured_at);
  const latest = sorted[0];
  let result: ProjectRecording[] = sorted;
  if (latest) {
    let validation: RecordingProbeResult;
    try {
      validation = await probe(latest.path);
    } catch (error) {
      emitDiscoveryResult({
        requestId,
        startedAt,
        event: "recording.discovery.failed",
        reasonCode: "probe_failed",
        details: {
          exports_present: true,
          bundle_candidates: bundleDiscovery.candidates,
          bundle_accepted: bundleRecordings.filter(Boolean).length,
          legacy_candidates: legacyCandidates.length,
          legacy_accepted: legacyRecordings.filter(Boolean).length,
          returned_count: sorted.length,
          latest_validation_status: "unvalidated",
          error_code: errorCode(error),
        },
      });
      throw error;
    }
    result = [
      validation.status === "valid"
        ? { ...latest, ...validation, validation: { status: "valid" as const } }
        : { ...latest, validation },
      ...sorted.slice(1),
    ];
  }
  const latestValidation = result[0]?.validation;
  emitDiscoveryResult({
    requestId,
    startedAt,
    event: bundleDiscovery.readErrorCode
      ? "recording.discovery.failed"
      : "recording.discovery.completed",
    reasonCode: bundleDiscovery.readErrorCode ? "takes_read_failed" : "discovery_completed",
    details: {
      exports_present: true,
      bundle_candidates: bundleDiscovery.candidates,
      bundle_accepted: bundleRecordings.filter(Boolean).length,
      legacy_candidates: legacyCandidates.length,
      legacy_accepted: legacyRecordings.filter(Boolean).length,
      returned_count: result.length,
      latest_validation_status: latestValidation?.status ?? "none",
      ...(latestValidation?.status === "invalid"
        ? { latest_validation_reason: latestValidation.reason }
        : {}),
      ...(bundleDiscovery.readErrorCode
        ? { error_code: bundleDiscovery.readErrorCode }
        : {}),
    },
  });
  return result;
}

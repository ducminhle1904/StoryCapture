import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRecordingV4Bundle } from "@storycapture/shared-types/recording-v4";
import type { RecordingProbeResult } from "./media-probe";

export async function discoverProjectRecordings(
  exportsDir: string,
  _probe?: (filePath: string) => Promise<RecordingProbeResult>,
) {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const recordings = await Promise.all([
    ...entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(".sc-recording"))
      .map(async (entry) => {
        const bundlePath = path.join(exportsDir, entry.name);
        const raw = await fs
          .readFile(path.join(bundlePath, "manifest.json"), "utf8")
          .then((text) => JSON.parse(text) as unknown)
          .catch(() => null);
        const manifest = readRecordingV4Bundle(raw);
        if (manifest?.status !== "completed") return null;
        const stat = await fs.stat(bundlePath).catch(() => null);
        if (!stat?.isDirectory()) return null;
        const resolveArtifact = (relativePath: string | null): string | null =>
          relativePath ? path.join(bundlePath, relativePath) : null;
        const microphone = manifest.audio.find((audio) => audio.role === "microphone") ?? null;
        const system = manifest.audio.find((audio) => audio.role === "system") ?? null;
        return {
          version: 4 as const,
          path: path.join(bundlePath, manifest.master.relative_path),
          captured_at: stat.mtimeMs,
          size: manifest.master.bytes,
          duration_ms: Math.round(manifest.artifact.duration_us / 1_000),
          width: manifest.dimensions.physical_width,
          height: manifest.dimensions.physical_height,
          codec: manifest.master.codec,
          container: "mp4",
          validation: { status: "valid" as const },
          master_path: path.join(bundlePath, manifest.master.relative_path),
          proxy_path: null,
          cadence_evidence_path: path.join(bundlePath, manifest.evidence.cadence_path),
          quality_evidence_path: path.join(bundlePath, manifest.evidence.quality_path),
          actions_path: resolveArtifact(manifest.sidecars.actions_path),
          microphone_audio_path: resolveArtifact(microphone?.relative_path ?? null),
          system_audio_path: resolveArtifact(system?.relative_path ?? null),
          exact_source_fps: manifest.master.frame_rate,
          source_frame_count: manifest.master.frame_count,
          certified_tier: null,
          quality_verdict: manifest.quality.verdict,
          bundle_path: bundlePath,
        };
      }),
  ]);
  return recordings
    .filter((recording) => recording !== null)
    .sort((a, b) => b.captured_at - a.captured_at);
}

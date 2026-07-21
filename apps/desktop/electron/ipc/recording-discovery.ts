import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readRecordingBundle } from "@storycapture/shared-types/recording-v2";

import { probeRecording, type RecordingProbeResult } from "./media-probe";

export async function discoverProjectRecordings(
  exportsDir: string,
  probe: (filePath: string) => Promise<RecordingProbeResult> = probeRecording,
) {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const recordings = await Promise.all([
    ...entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp4"))
      .map(async (entry) => {
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
    ...entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(".sc-recording"))
      .map(async (entry) => {
        const bundlePath = path.join(exportsDir, entry.name);
        const raw = await fs
          .readFile(path.join(bundlePath, "manifest.json"), "utf8")
          .then((text) => JSON.parse(text) as unknown)
          .catch(() => null);
        const manifest = readRecordingBundle(raw);
        if (!manifest || manifest.status !== "completed" || !manifest.proxy) return null;
        const stat = await fs.stat(bundlePath).catch(() => null);
        if (!stat?.isDirectory()) return null;
        const resolveArtifact = (relativePath: string | null): string | null =>
          relativePath ? path.join(bundlePath, relativePath) : null;
        const fps = manifest.master.exact_fps.numerator / manifest.master.exact_fps.denominator;
        if (manifest.schema_version === 3) {
          return {
            version: 3 as const,
            path: path.join(bundlePath, manifest.proxy.relative_path),
            captured_at: stat.mtimeMs,
            size: manifest.proxy.bytes,
            duration_ms: Math.round((manifest.master.frame_count / fps) * 1_000),
            width: manifest.capture_contract.dimensions.physical_width,
            height: manifest.capture_contract.dimensions.physical_height,
            codec: manifest.proxy.codec,
            container: "mp4",
            validation: { status: "valid" as const },
            master_path: path.join(bundlePath, manifest.master.relative_path),
            proxy_path: path.join(bundlePath, manifest.proxy.relative_path),
            cadence_evidence_path: path.join(bundlePath, manifest.evidence.cadence_path),
            quality_evidence_path: path.join(bundlePath, manifest.evidence.runtime_quality_path),
            frame_ledger_path: path.join(bundlePath, manifest.frame_ledger_path),
            actions_path: resolveArtifact(manifest.sidecars.actions_path),
            cursor_path: resolveArtifact(manifest.sidecars.cursor_path),
            microphone_audio_path: null,
            system_audio_path: null,
            exact_source_fps: manifest.master.exact_fps,
            source_frame_count: manifest.master.frame_count,
            certified_tier: null,
            certification_profile: manifest.certification_profile,
            guarantee_boundary: manifest.capture_contract.guarantee_boundary,
            source_scope_verified: true as const,
            quality_verdict: "passed" as const,
            bundle_path: bundlePath,
          };
        }
        const microphone = manifest.audio.find((audio) => audio.role === "microphone") ?? null;
        const system = manifest.audio.find((audio) => audio.role === "system") ?? null;
        return {
          version: 2 as const,
          path: path.join(bundlePath, manifest.proxy.relative_path),
          captured_at: stat.mtimeMs,
          size: manifest.proxy.bytes,
          duration_ms: Math.round((manifest.master.frame_count / fps) * 1_000),
          width: manifest.capture_contract.dimensions.physical_width,
          height: manifest.capture_contract.dimensions.physical_height,
          codec: manifest.proxy.codec,
          container: "mp4",
          validation: { status: "valid" as const },
          master_path: path.join(bundlePath, manifest.master.relative_path),
          proxy_path: path.join(bundlePath, manifest.proxy.relative_path),
          cadence_evidence_path: path.join(bundlePath, manifest.evidence.cadence_path),
          quality_evidence_path: path.join(bundlePath, manifest.evidence.quality_path),
          actions_path: resolveArtifact(manifest.sidecars.actions_path),
          microphone_audio_path: resolveArtifact(microphone?.relative_path ?? null),
          system_audio_path: resolveArtifact(system?.relative_path ?? null),
          exact_source_fps: manifest.master.exact_fps,
          source_frame_count: manifest.master.frame_count,
          certified_tier: manifest.certified_tier,
          quality_verdict: "passed" as const,
          bundle_path: bundlePath,
        };
      }),
  ]);
  const sorted = recordings
    .filter((recording) => recording !== null)
    .sort((a, b) => b.captured_at - a.captured_at);
  const latest = sorted[0];
  if (!latest) return sorted;
  if (latest.validation.status === "valid") return sorted;
  const validation = await probe(latest.path);
  return [
    validation.status === "valid"
      ? { ...latest, ...validation, validation: { status: "valid" as const } }
      : { ...latest, validation },
    ...sorted.slice(1),
  ];
}

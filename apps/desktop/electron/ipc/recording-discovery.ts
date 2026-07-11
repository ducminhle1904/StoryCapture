import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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
  const recordings = await Promise.all(
    entries
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
  );
  const sorted = recordings
    .filter((recording) => recording !== null)
    .sort((a, b) => b.captured_at - a.captured_at);
  const latest = sorted[0];
  if (!latest) return sorted;
  const validation = await probe(latest.path);
  return [
    validation.status === "valid"
      ? { ...latest, ...validation, validation: { status: "valid" as const } }
      : { ...latest, validation },
    ...sorted.slice(1),
  ];
}

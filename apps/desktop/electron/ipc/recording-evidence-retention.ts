import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./json-store";

export interface PersistedRecordingEvidence<T> {
  version: 1;
  status: "passed" | "failed";
  captured_at: string;
  evidence: T | null;
  error: string | null;
  retained_artifacts: string[];
}

async function existingRelativePaths(directory: string, artifactPaths: readonly string[]) {
  const existing: string[] = [];
  for (const artifactPath of artifactPaths) {
    if (
      await fs
        .stat(artifactPath)
        .then(() => true)
        .catch(() => false)
    ) {
      existing.push(path.relative(directory, artifactPath));
    }
  }
  return existing;
}

export async function retainRecordingVerificationEvidence<T>(options: {
  directory: string;
  artifactPaths: readonly string[];
  status: "passed" | "failed";
  evidence: T | null;
  error?: string | null;
}): Promise<{ evidencePath: string; record: PersistedRecordingEvidence<T> }> {
  await fs.mkdir(options.directory, { recursive: true });
  const evidencePath = path.join(options.directory, "evidence.json");
  const capturedAt = new Date().toISOString();
  const initialRecord: PersistedRecordingEvidence<T> = {
    version: 1,
    status: options.status,
    captured_at: capturedAt,
    evidence: options.evidence,
    error: options.error ?? null,
    retained_artifacts: await existingRelativePaths(options.directory, options.artifactPaths),
  };
  await writeJsonAtomic(evidencePath, initialRecord);

  if (options.status === "failed") return { evidencePath, record: initialRecord };

  const cleanupResults = await Promise.allSettled(
    options.artifactPaths.map((artifactPath) => fs.rm(artifactPath, { force: true })),
  );
  const cleanupFailure = cleanupResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (cleanupFailure) {
    const failedRecord: PersistedRecordingEvidence<T> = {
      ...initialRecord,
      status: "failed",
      error: `Artifact cleanup failed: ${String(cleanupFailure.reason)}`,
      retained_artifacts: await existingRelativePaths(options.directory, options.artifactPaths),
    };
    await writeJsonAtomic(evidencePath, failedRecord);
    throw cleanupFailure.reason;
  }

  const finalRecord: PersistedRecordingEvidence<T> = {
    ...initialRecord,
    retained_artifacts: [],
  };
  await writeJsonAtomic(evidencePath, finalRecord);
  return { evidencePath, record: finalRecord };
}

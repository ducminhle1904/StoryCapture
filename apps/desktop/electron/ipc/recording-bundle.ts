import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  RecordingBundleArtifactV2,
  RecordingBundleV2,
  RecordingBundleV3,
} from "@storycapture/shared-types/recording-v2";
import type { RecordingFrameLedgerEntry } from "./recording-frame-ring";

const GIB = 1024 ** 3;
export const RECORDING_PREFLIGHT_RESERVE_BYTES = 5 * GIB;
export const RECORDING_LIVE_RESERVE_SECONDS = 120;
const STAGING_PREFIX = ".storycapture-recording-staging-";

export interface RecordingStorageEstimateInput {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** Expected FFV1 bytes divided by raw BGRA bytes. Conservative default: 0.7. */
  compressionRatio?: number;
}

export interface RecordingStoragePreflight {
  estimated_bytes_per_second: number;
  required_bytes_for_ten_minutes: number;
  available_bytes: number;
  reserve_bytes: number;
  eligible: boolean;
}

export function estimateFfv1Storage(input: RecordingStorageEstimateInput): {
  bytesPerSecond: number;
  totalBytes: number;
} {
  const { width, height, fps, durationSeconds } = input;
  if (
    ![width, height, fps, durationSeconds].every((value) => Number.isFinite(value) && value > 0)
  ) {
    throw new Error("storage estimate requires positive finite dimensions, fps, and duration");
  }
  const compressionRatio = Math.min(1, Math.max(0.05, input.compressionRatio ?? 0.7));
  const bytesPerSecond = Math.ceil(width * height * 4 * fps * compressionRatio);
  return { bytesPerSecond, totalBytes: Math.ceil(bytesPerSecond * durationSeconds) };
}

export async function recordingStoragePreflight(
  directory: string,
  dimensions: { width: number; height: number; fps: number },
  statfs: typeof fs.statfs = fs.statfs,
): Promise<RecordingStoragePreflight> {
  const estimate = estimateFfv1Storage({ ...dimensions, durationSeconds: 600 });
  const stats = await statfs(directory);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  return {
    estimated_bytes_per_second: Math.ceil(estimate.bytesPerSecond),
    required_bytes_for_ten_minutes: estimate.totalBytes,
    available_bytes: availableBytes,
    reserve_bytes: RECORDING_PREFLIGHT_RESERVE_BYTES,
    eligible: availableBytes >= estimate.totalBytes + RECORDING_PREFLIGHT_RESERVE_BYTES,
  };
}

export async function hasLiveRecordingReserve(
  directory: string,
  estimatedBytesPerSecond: number,
  statfs: typeof fs.statfs = fs.statfs,
): Promise<boolean> {
  const stats = await statfs(directory);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  return availableBytes >= estimatedBytesPerSecond * RECORDING_LIVE_RESERVE_SECONDS;
}

function assertContained(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`recording bundle path escapes or aliases its parent: ${candidate}`);
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function recordingBundleArtifact(
  bundleRoot: string,
  relativePath: string,
): Promise<RecordingBundleArtifactV2> {
  const filePath = path.join(bundleRoot, relativePath);
  assertContained(bundleRoot, filePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`recording bundle artifact is not a file: ${relativePath}`);
  return { relative_path: relativePath, bytes: stat.size, sha256: await sha256File(filePath) };
}

export class RecordingSequenceLedger {
  private readonly entries: RecordingFrameLedgerEntry[] = [];

  append(entry: RecordingFrameLedgerEntry): void {
    const previous = this.entries.at(-1);
    if (entry.frame_index !== this.entries.length)
      throw new Error("frame ledger index is not contiguous");
    if (previous && entry.source_sequence !== previous.source_sequence + 1) {
      throw new Error("frame ledger source sequence is not contiguous");
    }
    if (previous && entry.native_pts_us <= previous.native_pts_us) {
      throw new Error("frame ledger native PTS is not strictly increasing");
    }
    this.entries.push({ ...entry });
  }

  snapshot(): RecordingFrameLedgerEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  async writeJsonLines(filePath: string): Promise<void> {
    const text = this.entries.map((entry) => JSON.stringify(entry)).join("\n");
    await fs.writeFile(filePath, text ? `${text}\n` : "", "utf8");
  }
}

export class RecordingBundleWorkspace {
  private committed = false;

  private constructor(
    readonly exportsDir: string,
    readonly stagingPath: string,
    readonly finalPath: string,
  ) {}

  static async create(
    exportsDir: string,
    name = `recording-${randomUUID()}`,
  ): Promise<RecordingBundleWorkspace> {
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const stagingPath = path.join(exportsDir, `${STAGING_PREFIX}${randomUUID()}`);
    const finalPath = path.join(exportsDir, `${safeName}.sc-recording`);
    assertContained(exportsDir, stagingPath);
    assertContained(exportsDir, finalPath);
    await fs.mkdir(exportsDir, { recursive: true });
    await fs.mkdir(stagingPath, { recursive: false });
    await Promise.all(
      ["master", "proxy", "audio", "evidence", "sidecars", "diagnostics"].map((directory) =>
        fs.mkdir(path.join(stagingPath, directory)),
      ),
    );
    activeRecordingStagingPaths.add(stagingPath);
    return new RecordingBundleWorkspace(exportsDir, stagingPath, finalPath);
  }

  resolve(relativePath: string): string {
    const candidate = path.join(this.stagingPath, relativePath);
    assertContained(this.stagingPath, candidate);
    return candidate;
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    const destination = this.resolve(relativePath);
    const temp = `${destination}.tmp-${randomUUID()}`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temp, destination);
  }

  async commit(manifest: RecordingBundleV2 | RecordingBundleV3): Promise<string> {
    if (this.committed) throw new Error("recording bundle workspace is already committed");
    await this.writeJson("manifest.json", manifest);
    await fs.rename(this.stagingPath, this.finalPath);
    this.committed = true;
    activeRecordingStagingPaths.delete(this.stagingPath);
    return this.finalPath;
  }

  async discard(): Promise<void> {
    if (this.committed) return;
    assertContained(this.exportsDir, this.stagingPath);
    if (!path.basename(this.stagingPath).startsWith(STAGING_PREFIX)) {
      throw new Error("refusing to remove a non-recording staging path");
    }
    try {
      await fs.rm(this.stagingPath, { recursive: true, force: true });
    } finally {
      activeRecordingStagingPaths.delete(this.stagingPath);
    }
  }
}

const activeRecordingStagingPaths = new Set<string>();
const DEFAULT_ORPHAN_STAGING_MIN_AGE_MS = 60 * 60 * 1_000;

export async function cleanupPartialRecordingBundles(
  exportsDir: string,
  options: { minAgeMs?: number; nowMs?: number } = {},
): Promise<number> {
  const minAgeMs = options.minAgeMs ?? DEFAULT_ORPHAN_STAGING_MIN_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const entries = await fs.readdir(exportsDir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
    const target = path.join(exportsDir, entry.name);
    assertContained(exportsDir, target);
    if (activeRecordingStagingPaths.has(target)) continue;
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || nowMs - stat.mtimeMs < minAgeMs) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

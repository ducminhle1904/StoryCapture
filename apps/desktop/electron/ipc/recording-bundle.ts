import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RecordingOutcomeV1, RecordingVerdict } from "@storycapture/shared-types";
import { probeRecording, type RecordingProbeResult } from "./media-probe";
import { recordEngineLog } from "./recording-observability";

export type RecordingBundleMode = "off" | "shadow" | "required";
export type RecordingArtifactKind =
  | "video"
  | "audio"
  | "actions"
  | "health"
  | "segment"
  | "diagnostic";

export interface RecordingBundleArtifactV1 {
  kind: RecordingArtifactKind;
  relative_path: string;
  bytes: number;
  sha256: string;
  required: boolean;
}

export interface RecordingBundleV1 {
  version: 1;
  take_id: string;
  session_id: string;
  verdict: RecordingVerdict;
  created_at: string;
  committed_at: string;
  story_hash: string | null;
  capture: {
    target_kind: string;
    width: number;
    height: number;
    output_width: number;
    output_height: number;
    requested_fps: number;
    observed_fps: number;
  };
  artifacts: RecordingBundleArtifactV1[];
  outcome: RecordingOutcomeV1;
}

export interface RecordingBundleAllocation {
  takeId: string;
  sessionId: string;
  createdAt: string;
  stagingRoot: string;
  finalRoot: string;
  stagingVideoPath: string;
  finalVideoPath: string;
  audioDir: string;
  actionsPath: string;
  healthPath: string;
  segmentsDir: string;
}

interface ArtifactRegistration {
  kind: RecordingArtifactKind;
  relativePath: string;
  required: boolean;
}

export interface RecordingBundleCommitInput {
  outcome: RecordingOutcomeV1;
  storyHash?: string | null;
  capture: RecordingBundleV1["capture"];
}

interface RecordingBundleWriterOptions {
  probe?: (filePath: string) => Promise<RecordingProbeResult>;
}

const writersBySession = new Map<string, RecordingBundleWriter>();

export class RecordingBundleCommitError extends Error {
  readonly recordingReasonCode = "bundle_commit_failed" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecordingBundleCommitError";
  }
}

export function recordingBundleMode(
  value = process.env.STORYCAPTURE_RECORDING_BUNDLE_MODE,
): RecordingBundleMode {
  return value === "shadow" || value === "required" ? value : "off";
}

function canonicalRelativePath(value: string): string {
  if (!value || path.isAbsolute(value)) {
    throw new RecordingBundleCommitError("bundle artifact path must be relative");
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new RecordingBundleCommitError("bundle artifact path escapes its root");
  }
  return normalized;
}

function resolveContained(root: string, relativePath: string): string {
  const normalized = canonicalRelativePath(relativePath);
  const resolved = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RecordingBundleCommitError("bundle artifact path escapes its root");
  }
  return resolved;
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomicDurable(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  await syncDirectory(path.dirname(file));
}

function manifestsEquivalent(left: RecordingBundleV1, right: RecordingBundleV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class RecordingBundleWriter {
  readonly allocation: RecordingBundleAllocation;
  readonly #probe: (filePath: string) => Promise<RecordingProbeResult>;
  readonly #artifacts = new Map<string, ArtifactRegistration>();

  private constructor(
    allocation: RecordingBundleAllocation,
    options: RecordingBundleWriterOptions,
  ) {
    this.allocation = allocation;
    this.#probe = options.probe ?? probeRecording;
  }

  static async allocate(
    sessionId: string,
    projectFolder: string,
    options: RecordingBundleWriterOptions = {},
  ): Promise<RecordingBundleWriter> {
    const takeId = randomUUID();
    const takesRoot = path.join(projectFolder, "exports", "takes");
    const stagingRoot = path.join(takesRoot, `.${takeId}.staging.${process.pid}`);
    const finalRoot = path.join(takesRoot, takeId);
    const allocation: RecordingBundleAllocation = {
      takeId,
      sessionId,
      createdAt: new Date().toISOString(),
      stagingRoot,
      finalRoot,
      stagingVideoPath: path.join(stagingRoot, "media", "video.mp4"),
      finalVideoPath: path.join(finalRoot, "media", "video.mp4"),
      audioDir: path.join(stagingRoot, "media", "audio"),
      actionsPath: path.join(stagingRoot, "sidecars", "actions.json"),
      healthPath: path.join(stagingRoot, "health.json"),
      segmentsDir: path.join(stagingRoot, "segments"),
    };
    await fs.mkdir(allocation.audioDir, { recursive: true });
    await fs.mkdir(path.dirname(allocation.actionsPath), { recursive: true });
    await fs.mkdir(allocation.segmentsDir, { recursive: true });
    const writer = new RecordingBundleWriter(allocation, options);
    writersBySession.set(sessionId, writer);
    return writer;
  }

  static resume(
    allocation: RecordingBundleAllocation,
    options: RecordingBundleWriterOptions = {},
  ): RecordingBundleWriter {
    const writer = new RecordingBundleWriter(allocation, options);
    writersBySession.set(allocation.sessionId, writer);
    return writer;
  }

  registerArtifact(kind: RecordingArtifactKind, relativePath: string, required: boolean): void {
    const canonical = canonicalRelativePath(relativePath);
    const existing = this.#artifacts.get(canonical);
    if (existing && (existing.kind !== kind || existing.required !== required)) {
      throw new RecordingBundleCommitError(`conflicting artifact registration: ${canonical}`);
    }
    this.#artifacts.set(canonical, { kind, relativePath: canonical, required });
  }

  async commit(input: RecordingBundleCommitInput): Promise<{
    manifest: RecordingBundleV1;
    outputPath: string | null;
  }> {
    this.registerArtifact("video", "media/video.mp4", input.outcome.verdict !== "failed");
    this.registerArtifact("actions", "sidecars/actions.json", true);
    this.registerArtifact("health", "health.json", true);
    let manifest: RecordingBundleV1;
    try {
      const artifacts = await this.#materializeArtifacts();
      manifest = {
        version: 1,
        take_id: this.allocation.takeId,
        session_id: this.allocation.sessionId,
        verdict: input.outcome.verdict,
        created_at: this.allocation.createdAt,
        committed_at: new Date().toISOString(),
        story_hash: input.storyHash ?? null,
        capture: input.capture,
        artifacts,
        outcome: input.outcome,
      };
      await writeJsonAtomicDurable(
        path.join(this.allocation.stagingRoot, "manifest.json"),
        manifest,
      );
      const validated = await validateRecordingBundleRoot(this.allocation.stagingRoot, this.#probe);
      if (!manifestsEquivalent(manifest, validated)) {
        throw new RecordingBundleCommitError("staged manifest changed during validation");
      }
      const existing = await readRecordingBundleManifest(this.allocation.finalRoot);
      if (existing) {
        if (!manifestsEquivalent(manifest, existing)) {
          throw new RecordingBundleCommitError(
            "take destination already exists with different bytes",
          );
        }
        const result = {
          manifest: existing,
          outputPath: existing.artifacts.some(
            (artifact) => artifact.kind === "video" && artifact.relative_path === "media/video.mp4",
          )
            ? this.allocation.finalVideoPath
            : null,
        };
        await recordEngineLog({
          event: "recording.bundle.committed",
          context: {
            session_id: this.allocation.sessionId,
            take_id: this.allocation.takeId,
            verdict: existing.verdict,
            artifact_relpath: "manifest.json",
          },
          details: { artifact_count: existing.artifacts.length, reused: true },
        });
        return result;
      }
      await fs.rename(this.allocation.stagingRoot, this.allocation.finalRoot);
      await syncDirectory(path.dirname(this.allocation.finalRoot));
      writersBySession.delete(this.allocation.sessionId);
      const result = {
        manifest,
        outputPath: artifacts.some(
          (artifact) => artifact.kind === "video" && artifact.relative_path === "media/video.mp4",
        )
          ? this.allocation.finalVideoPath
          : null,
      };
      await recordEngineLog({
        event: "recording.bundle.committed",
        context: {
          session_id: this.allocation.sessionId,
          take_id: this.allocation.takeId,
          verdict: manifest.verdict,
          artifact_relpath: "manifest.json",
        },
        details: { artifact_count: artifacts.length, reused: false },
      });
      return result;
    } catch (error) {
      await recordEngineLog({
        level: "error",
        event: "recording.bundle.failed",
        context: {
          session_id: this.allocation.sessionId,
          take_id: this.allocation.takeId,
          verdict: input.outcome.verdict,
          reason_code: "bundle_commit_failed",
        },
        error,
      });
      if (error instanceof RecordingBundleCommitError) throw error;
      throw new RecordingBundleCommitError("recording bundle publication failed", {
        cause: error,
      });
    }
  }

  async #materializeArtifacts(): Promise<RecordingBundleArtifactV1[]> {
    const rootReal = await fs.realpath(this.allocation.stagingRoot);
    const artifacts: RecordingBundleArtifactV1[] = [];
    for (const registration of [...this.#artifacts.values()].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    )) {
      const file = resolveContained(this.allocation.stagingRoot, registration.relativePath);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile()) {
        if (!registration.required) continue;
        throw new RecordingBundleCommitError(
          `required bundle artifact is missing: ${registration.relativePath}`,
        );
      }
      const real = await fs.realpath(file);
      if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
        throw new RecordingBundleCommitError(
          `bundle artifact resolves outside staging: ${registration.relativePath}`,
        );
      }
      artifacts.push({
        kind: registration.kind,
        relative_path: registration.relativePath,
        bytes: stat.size,
        sha256: await sha256File(file),
        required: registration.required,
      });
    }
    return artifacts;
  }
}

export function recordingBundleForSession(sessionId: string): RecordingBundleWriter | null {
  return writersBySession.get(sessionId) ?? null;
}

export function recordingBundleActionsPath(recordingPath: string): string | null {
  const normalized = path.normalize(recordingPath);
  for (const writer of writersBySession.values()) {
    if (
      normalized === path.normalize(writer.allocation.stagingVideoPath) ||
      normalized === path.normalize(writer.allocation.finalVideoPath)
    ) {
      const root =
        normalized === path.normalize(writer.allocation.finalVideoPath)
          ? writer.allocation.finalRoot
          : writer.allocation.stagingRoot;
      return path.join(root, "sidecars", "actions.json");
    }
  }
  if (
    path.basename(normalized) === "video.mp4" &&
    path.basename(path.dirname(normalized)) === "media"
  ) {
    return path.join(path.dirname(path.dirname(normalized)), "sidecars", "actions.json");
  }
  return null;
}

export function recordingBundlePublicVideoPath(recordingPath: string): string {
  const normalized = path.normalize(recordingPath);
  for (const writer of writersBySession.values()) {
    if (normalized === path.normalize(writer.allocation.stagingVideoPath)) {
      return writer.allocation.finalVideoPath;
    }
  }
  return recordingPath;
}

export async function readRecordingBundleManifest(
  bundleRoot: string,
): Promise<RecordingBundleV1 | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(bundleRoot, "manifest.json"), "utf8"));
    if (
      raw?.version !== 1 ||
      typeof raw.take_id !== "string" ||
      typeof raw.session_id !== "string" ||
      !Array.isArray(raw.artifacts) ||
      raw.outcome?.version !== 1
    ) {
      return null;
    }
    return raw as RecordingBundleV1;
  } catch {
    return null;
  }
}

export async function validateRecordingBundleRoot(
  bundleRoot: string,
  probe: (filePath: string) => Promise<RecordingProbeResult> = probeRecording,
): Promise<RecordingBundleV1> {
  const manifest = await readRecordingBundleManifest(bundleRoot);
  if (!manifest) throw new RecordingBundleCommitError("bundle manifest is missing or unsupported");
  for (const artifact of manifest.artifacts) {
    const file = resolveContained(bundleRoot, artifact.relative_path);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.size !== artifact.bytes) {
      throw new RecordingBundleCommitError(
        `bundle artifact size mismatch: ${artifact.relative_path}`,
      );
    }
    if ((await sha256File(file)) !== artifact.sha256) {
      throw new RecordingBundleCommitError(
        `bundle artifact hash mismatch: ${artifact.relative_path}`,
      );
    }
  }
  if (["passed", "repairable", "cancelled"].includes(manifest.verdict)) {
    const videoPath = resolveContained(bundleRoot, "media/video.mp4");
    const validation = await probe(videoPath);
    if (validation.status !== "valid") {
      throw new RecordingBundleCommitError("bundle video is not readable");
    }
  }
  return manifest;
}

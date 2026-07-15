import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RecordingOutcomeV1 } from "@storycapture/shared-types";
import { probeRecording, type RecordingProbeResult } from "./media-probe";
import { userDataPath } from "./paths";
import {
  type RecordingArtifactKind,
  type RecordingBundleAllocation,
  RecordingBundleWriter,
  readRecordingBundleManifest,
  validateRecordingBundleRoot,
} from "./recording-bundle";
import { recordEngineLog } from "./recording-observability";
import { classifyRecordingOutcome } from "./recording-outcome";

export type RecordingRecoveryMode = "off" | "observe" | "manual";
export type RecordingJournalCheckpoint =
  | "bundle_allocated"
  | "capture_started"
  | "first_encoded_frame"
  | "media_durable"
  | "stop_requested"
  | "bundle_published";

interface JournalArtifactV1 {
  kind: RecordingArtifactKind;
  relative_path: string;
  bytes: number;
  durable: boolean;
}

interface JournalCaptureFactsV1 {
  target_kind: string;
  width: number;
  height: number;
  output_width: number;
  output_height: number;
  requested_fps: number;
  observed_fps: number;
  frames_written: number;
  frames_dropped: number;
}

interface RecoverReceiptV1 {
  action: "recover";
  completed_at: string;
  result: Omit<RecoverInterruptedRecordingResultV1, "cached">;
}

interface DiscardReceiptV1 {
  action: "discard";
  completed_at: string;
  result: Omit<DiscardInterruptedRecordingResultV1, "cached">;
}

type JournalReceiptV1 = RecoverReceiptV1 | DiscardReceiptV1;

export interface RecordingSessionJournalV1 {
  version: 1;
  journal_id: string;
  take_id: string;
  session_id: string;
  host_pid: number;
  checkpoint: RecordingJournalCheckpoint;
  staging_root: string;
  final_root: string;
  created_at: string;
  updated_at: string;
  recovery_state: "active" | "recovering" | "discarding" | "committed" | "recovered" | "discarded";
  declared_artifacts: JournalArtifactV1[];
  capture: JournalCaptureFactsV1;
  receipt: JournalReceiptV1 | null;
  receipt_expires_at: string | null;
}

export interface InterruptedRecordingSummaryV1 {
  journal_id: string;
  take_id: string;
  interrupted_at: string;
  checkpoint: string;
  recoverability: "media" | "segments" | "diagnostic_only";
}

export interface ListInterruptedRecordingsResultV1 {
  version: 1;
  recordings: InterruptedRecordingSummaryV1[];
}

export interface RecoverInterruptedRecordingResultV1 {
  version: 1;
  journal_id: string;
  verdict: "repairable" | "failed";
  bundle_path: string;
  output_path: string | null;
  cached: boolean;
}

export interface DiscardInterruptedRecordingResultV1 {
  version: 1;
  journal_id: string;
  discarded: true;
  deleted_artifact_count: number;
  cached: boolean;
}

interface JournalStoreOptions {
  root?: string;
  mode?: RecordingRecoveryMode;
  now?: () => number;
  probe?: (filePath: string) => Promise<RecordingProbeResult>;
}

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function recordingRecoveryMode(
  value = process.env.STORYCAPTURE_RECORDING_RECOVERY_MODE,
): RecordingRecoveryMode {
  return value === "manual" || value === "observe" ? value : "off";
}

function canonicalRelativePath(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("journal artifact escapes canonical staging root");
  }
  return relative.split(path.sep).join("/");
}

function resolveJournalArtifact(journal: RecordingSessionJournalV1, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("journal artifact path must be relative");
  }
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error("journal artifact escapes canonical staging root");
  }
  const resolved = path.resolve(journal.staging_root, ...normalized.split("/"));
  const relative = path.relative(journal.staging_root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("journal artifact escapes canonical staging root");
  }
  return resolved;
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, file);
  await syncDirectory(path.dirname(file));
}

function isJournal(value: unknown): value is RecordingSessionJournalV1 {
  const journal = value as Partial<RecordingSessionJournalV1> | null;
  return Boolean(
    journal?.version === 1 &&
      typeof journal.journal_id === "string" &&
      typeof journal.take_id === "string" &&
      typeof journal.session_id === "string" &&
      typeof journal.staging_root === "string" &&
      typeof journal.final_root === "string" &&
      Array.isArray(journal.declared_artifacts),
  );
}

function allocationFromJournal(journal: RecordingSessionJournalV1): RecordingBundleAllocation {
  return {
    takeId: journal.take_id,
    sessionId: journal.session_id,
    createdAt: journal.created_at,
    stagingRoot: journal.staging_root,
    finalRoot: journal.final_root,
    stagingVideoPath: path.join(journal.staging_root, "media", "video.mp4"),
    finalVideoPath: path.join(journal.final_root, "media", "video.mp4"),
    audioDir: path.join(journal.staging_root, "media", "audio"),
    actionsPath: path.join(journal.staging_root, "sidecars", "actions.json"),
    healthPath: path.join(journal.staging_root, "health.json"),
    segmentsDir: path.join(journal.staging_root, "segments"),
  };
}

function validateJournalRoots(journal: RecordingSessionJournalV1): void {
  const stagingName = path.basename(journal.staging_root);
  if (!stagingName.startsWith(`.${journal.take_id}.staging.`)) {
    throw new Error("journal staging root is not canonical");
  }
  if (
    path.dirname(journal.staging_root) !== path.dirname(journal.final_root) ||
    path.basename(journal.final_root) !== journal.take_id
  ) {
    throw new Error("journal final root is not the canonical staging sibling");
  }
}

export class RecordingSessionJournalStore {
  readonly #rootOverride: string | undefined;
  readonly #modeOverride: RecordingRecoveryMode | undefined;
  readonly #now: () => number;
  readonly #probe: (filePath: string) => Promise<RecordingProbeResult>;
  readonly #journals = new Map<string, RecordingSessionJournalV1>();
  readonly #journalBySession = new Map<string, string>();
  readonly #corrupt = new Map<string, InterruptedRecordingSummaryV1>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #loaded = false;

  constructor(options: JournalStoreOptions = {}) {
    this.#rootOverride = options.root;
    this.#modeOverride = options.mode;
    this.#now = options.now ?? Date.now;
    this.#probe = options.probe ?? probeRecording;
  }

  get mode(): RecordingRecoveryMode {
    return this.#modeOverride ?? recordingRecoveryMode();
  }

  get root(): string {
    return this.#rootOverride ?? userDataPath("recording-journal");
  }

  async initialize(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journalId = entry.name.slice(0, -5);
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.root, entry.name), "utf8"));
        if (!isJournal(raw)) throw new Error("unsupported journal");
        this.#journals.set(raw.journal_id, raw);
        this.#journalBySession.set(raw.session_id, raw.journal_id);
      } catch {
        this.#corrupt.set(journalId, {
          journal_id: journalId,
          take_id: "unknown",
          interrupted_at: new Date(0).toISOString(),
          checkpoint: "corrupt",
          recoverability: "diagnostic_only",
        });
      }
    }
  }

  async createForBundle(
    allocation: RecordingBundleAllocation,
    capture: Partial<JournalCaptureFactsV1> = {},
  ): Promise<RecordingSessionJournalV1> {
    await this.initialize();
    const now = new Date(this.#now()).toISOString();
    const journal: RecordingSessionJournalV1 = {
      version: 1,
      journal_id: randomUUID(),
      take_id: allocation.takeId,
      session_id: allocation.sessionId,
      host_pid: process.pid,
      checkpoint: "bundle_allocated",
      staging_root: allocation.stagingRoot,
      final_root: allocation.finalRoot,
      created_at: allocation.createdAt,
      updated_at: now,
      recovery_state: "active",
      declared_artifacts: [],
      capture: {
        target_kind: capture.target_kind ?? "unknown",
        width: capture.width ?? 0,
        height: capture.height ?? 0,
        output_width: capture.output_width ?? 0,
        output_height: capture.output_height ?? 0,
        requested_fps: capture.requested_fps ?? 0,
        observed_fps: capture.observed_fps ?? 0,
        frames_written: capture.frames_written ?? 0,
        frames_dropped: capture.frames_dropped ?? 0,
      },
      receipt: null,
      receipt_expires_at: null,
    };
    validateJournalRoots(journal);
    this.#journals.set(journal.journal_id, journal);
    this.#journalBySession.set(journal.session_id, journal.journal_id);
    await this.#persist(journal);
    return journal;
  }

  async checkpoint(
    sessionId: string,
    checkpoint: RecordingJournalCheckpoint,
    options: {
      artifacts?: Array<{ kind: RecordingArtifactKind; file: string }>;
      capture?: Partial<JournalCaptureFactsV1>;
    } = {},
  ): Promise<void> {
    await this.initialize();
    const journal = this.#forSession(sessionId);
    if (!journal || journal.recovery_state !== "active") return;
    for (const artifact of options.artifacts ?? []) {
      const relativePath = canonicalRelativePath(journal.staging_root, artifact.file);
      const stat = await fs.lstat(artifact.file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const next: JournalArtifactV1 = {
        kind: artifact.kind,
        relative_path: relativePath,
        bytes: stat.size,
        durable: true,
      };
      const index = journal.declared_artifacts.findIndex(
        (entry) => entry.relative_path === relativePath,
      );
      if (index >= 0) journal.declared_artifacts[index] = next;
      else journal.declared_artifacts.push(next);
    }
    journal.capture = { ...journal.capture, ...options.capture };
    journal.checkpoint = checkpoint;
    journal.updated_at = new Date(this.#now()).toISOString();
    await this.#persist(journal);
  }

  traceContext(sessionId: string): {
    journal_id: string;
    take_id: string;
    checkpoint: RecordingJournalCheckpoint;
  } | null {
    const journalId = this.#journalBySession.get(sessionId);
    const journal = journalId ? this.#journals.get(journalId) : undefined;
    if (!journal) return null;
    return {
      journal_id: journal.journal_id,
      take_id: journal.take_id,
      checkpoint: journal.checkpoint,
    };
  }

  async markPublished(sessionId: string): Promise<void> {
    await this.initialize();
    const journal = this.#forSession(sessionId);
    if (!journal) return;
    journal.checkpoint = "bundle_published";
    journal.recovery_state = "committed";
    journal.updated_at = new Date(this.#now()).toISOString();
    journal.receipt_expires_at = new Date(this.#now() + RECEIPT_TTL_MS).toISOString();
    await this.#persist(journal);
  }

  async list(raw: unknown): Promise<ListInterruptedRecordingsResultV1> {
    const request = raw as { version?: unknown } | undefined;
    if (request?.version !== 1) throw new Error("list_interrupted_recordings requires version 1");
    if (this.mode === "off") return { version: 1, recordings: [] };
    await this.initialize();
    const recordings: InterruptedRecordingSummaryV1[] = [...this.#journals.values()]
      .filter(
        (journal) =>
          ["active", "recovering", "discarding"].includes(journal.recovery_state) &&
          journal.host_pid !== process.pid,
      )
      .map((journal) => ({
        journal_id: journal.journal_id,
        take_id: journal.take_id,
        interrupted_at: journal.updated_at,
        checkpoint: journal.checkpoint,
        recoverability: this.#recoverability(journal),
      }));
    recordings.push(...this.#corrupt.values());
    recordings.sort(
      (left, right) =>
        left.interrupted_at.localeCompare(right.interrupted_at) ||
        left.journal_id.localeCompare(right.journal_id),
    );
    await Promise.all(
      recordings.map((recording) => {
        const journal = this.#journals.get(recording.journal_id);
        return recordEngineLog({
          level: recording.recoverability === "diagnostic_only" ? "warn" : "info",
          event: "recording.recovery.discovered",
          context: {
            session_id: journal?.session_id,
            take_id: recording.take_id,
            phase: recording.checkpoint,
          },
          details: {
            journal_id: recording.journal_id,
            recoverability: recording.recoverability,
          },
        });
      }),
    );
    return { version: 1, recordings };
  }

  async recover(raw: unknown): Promise<RecoverInterruptedRecordingResultV1> {
    const request = raw as
      | { version?: unknown; journal_id?: unknown; request_id?: unknown }
      | undefined;
    this.#validateMutationRequest(request, "recover_interrupted_recording");
    if (this.mode !== "manual") throw new Error("recording recovery requires manual mode");
    await this.initialize();
    const journalId = String(request?.journal_id ?? "");
    return this.#withLock(journalId, async () => {
      const journal = this.#journals.get(journalId);
      if (!journal) throw new Error(`recording journal ${journalId} not found`);
      const cached = this.#cachedReceipt(journal, "recover");
      if (cached) {
        await recordEngineLog({
          event: "recording.recovery.recovered",
          context: {
            request_id: String(request?.request_id ?? ""),
            session_id: journal.session_id,
            take_id: journal.take_id,
            verdict: cached.verdict,
          },
          details: { cached: true, journal_id: journal.journal_id },
        });
        return { ...cached, cached: true };
      }
      validateJournalRoots(journal);
      if (journal.recovery_state === "discarding") {
        throw new Error("recording journal has an interrupted discard; retry discard");
      }
      const existingManifest = await readRecordingBundleManifest(journal.final_root);
      if (existingManifest && journal.recovery_state === "recovering") {
        const manifest = await validateRecordingBundleRoot(journal.final_root, this.#probe);
        if (manifest.verdict !== "repairable" && manifest.verdict !== "failed") {
          throw new Error("interrupted recovery committed an unsupported verdict");
        }
        const hasReadableVideo =
          manifest.verdict === "repairable" &&
          manifest.artifacts.some(
            (artifact) => artifact.kind === "video" && artifact.relative_path === "media/video.mp4",
          );
        const result: Omit<RecoverInterruptedRecordingResultV1, "cached"> = {
          version: 1,
          journal_id: journal.journal_id,
          verdict: manifest.verdict,
          bundle_path: journal.final_root,
          output_path: hasReadableVideo ? allocationFromJournal(journal).finalVideoPath : null,
        };
        journal.recovery_state = "recovered";
        journal.checkpoint = "bundle_published";
        journal.updated_at = new Date(this.#now()).toISOString();
        journal.receipt = {
          action: "recover",
          completed_at: journal.updated_at,
          result,
        };
        journal.receipt_expires_at = new Date(this.#now() + RECEIPT_TTL_MS).toISOString();
        await this.#persist(journal);
        await recordEngineLog({
          event: "recording.recovery.recovered",
          context: {
            request_id: String(request?.request_id ?? ""),
            session_id: journal.session_id,
            take_id: journal.take_id,
            verdict: result.verdict,
          },
          details: { cached: false, journal_id: journal.journal_id },
        });
        return { ...result, cached: false };
      }
      if (existingManifest) {
        throw new Error("interrupted recording is already committed");
      }
      if (journal.recovery_state !== "active" && journal.recovery_state !== "recovering") {
        throw new Error(`recording journal cannot recover from ${journal.recovery_state}`);
      }
      journal.recovery_state = "recovering";
      journal.updated_at = new Date(this.#now()).toISOString();
      await this.#persist(journal);

      const allocation = allocationFromJournal(journal);
      const writer = RecordingBundleWriter.resume(allocation, { probe: this.#probe });
      await fs.mkdir(path.dirname(allocation.actionsPath), { recursive: true });
      await fs.mkdir(allocation.audioDir, { recursive: true });
      await fs.mkdir(allocation.segmentsDir, { recursive: true });
      if (!(await fs.stat(allocation.actionsPath).catch(() => null))?.isFile()) {
        await writeJsonAtomicDurable(allocation.actionsPath, {
          version: 1,
          recording_path: allocation.finalVideoPath,
          events: [],
          recovered: true,
        });
      }
      if (!(await fs.stat(allocation.healthPath).catch(() => null))?.isFile()) {
        await writeJsonAtomicDurable(allocation.healthPath, {
          version: 1,
          session_id: journal.session_id,
          recovery: "interrupted",
        });
      }
      for (const artifact of journal.declared_artifacts) {
        if (
          artifact.relative_path === "media/video.mp4" ||
          artifact.relative_path === "sidecars/actions.json" ||
          artifact.relative_path === "health.json"
        ) {
          continue;
        }
        resolveJournalArtifact(journal, artifact.relative_path);
        writer.registerArtifact(artifact.kind, artifact.relative_path, false);
      }

      const videoStat = await fs.stat(allocation.stagingVideoPath).catch(() => null);
      const videoProbe = videoStat?.isFile()
        ? await this.#probe(allocation.stagingVideoPath).catch(() => null)
        : null;
      const videoReadable = videoProbe?.status === "valid";
      const automation: RecordingOutcomeV1["automation"] = {
        exit_reason: "completed",
        total_steps: 0,
        succeeded: 0,
        failed: 0,
        failed_ordinal: null,
      };
      const outcome = videoReadable
        ? classifyRecordingOutcome({
            session_id: journal.session_id,
            automation,
            capture: {
              output_path: allocation.finalVideoPath,
              frames_written: Math.max(1, journal.capture.frames_written),
              frames_dropped: journal.capture.frames_dropped,
              cadence_warning: null,
              finalized: true,
            },
            artifact_readable: true,
            terminal_reason_code: "recovery_salvaged",
          })
        : classifyRecordingOutcome({
            session_id: journal.session_id,
            automation,
            capture: {
              output_path: null,
              frames_written: 0,
              frames_dropped: journal.capture.frames_dropped,
              cadence_warning: null,
              finalized: false,
            },
            artifact_readable: false,
            terminal_reason_code: "artifact_missing",
          });
      const committed = await writer.commit({
        outcome,
        capture: {
          target_kind: journal.capture.target_kind,
          width: journal.capture.width,
          height: journal.capture.height,
          output_width: journal.capture.output_width,
          output_height: journal.capture.output_height,
          requested_fps: journal.capture.requested_fps,
          observed_fps: journal.capture.observed_fps,
        },
      });
      const result: Omit<RecoverInterruptedRecordingResultV1, "cached"> = {
        version: 1,
        journal_id: journal.journal_id,
        verdict: videoReadable ? "repairable" : "failed",
        bundle_path: journal.final_root,
        output_path: videoReadable ? committed.outputPath : null,
      };
      journal.recovery_state = "recovered";
      journal.checkpoint = "bundle_published";
      journal.updated_at = new Date(this.#now()).toISOString();
      journal.receipt = {
        action: "recover",
        completed_at: journal.updated_at,
        result,
      };
      journal.receipt_expires_at = new Date(this.#now() + RECEIPT_TTL_MS).toISOString();
      await this.#persist(journal);
      await recordEngineLog({
        event: "recording.recovery.recovered",
        context: {
          request_id: String(request?.request_id ?? ""),
          session_id: journal.session_id,
          take_id: journal.take_id,
          verdict: result.verdict,
        },
        details: { cached: false, journal_id: journal.journal_id },
      });
      return { ...result, cached: false };
    });
  }

  async discard(raw: unknown): Promise<DiscardInterruptedRecordingResultV1> {
    const request = raw as
      | { version?: unknown; journal_id?: unknown; request_id?: unknown }
      | undefined;
    this.#validateMutationRequest(request, "discard_interrupted_recording");
    if (this.mode !== "manual") throw new Error("recording recovery requires manual mode");
    await this.initialize();
    const journalId = String(request?.journal_id ?? "");
    return this.#withLock(journalId, async () => {
      const journal = this.#journals.get(journalId);
      if (!journal) throw new Error(`recording journal ${journalId} not found`);
      const cached = this.#cachedReceipt(journal, "discard");
      if (cached) {
        await recordEngineLog({
          event: "recording.recovery.discarded",
          context: {
            request_id: String(request?.request_id ?? ""),
            session_id: journal.session_id,
            take_id: journal.take_id,
          },
          details: { cached: true, journal_id: journal.journal_id },
        });
        return { ...cached, cached: true };
      }
      validateJournalRoots(journal);
      if (journal.recovery_state === "recovering") {
        throw new Error("recording journal has an interrupted recovery; retry recover");
      }
      if (journal.recovery_state !== "active" && journal.recovery_state !== "discarding") {
        throw new Error(`recording journal cannot discard from ${journal.recovery_state}`);
      }
      if (await readRecordingBundleManifest(journal.final_root)) {
        throw new Error("cannot discard a committed recording bundle");
      }
      journal.recovery_state = "discarding";
      journal.updated_at = new Date(this.#now()).toISOString();
      await this.#persist(journal);
      let deletedArtifactCount = 0;
      for (const artifact of journal.declared_artifacts) {
        const file = resolveJournalArtifact(journal, artifact.relative_path);
        const stat = await fs.lstat(file).catch(() => null);
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`unsafe journal artifact: ${artifact.relative_path}`);
        }
        await fs.rm(file);
        deletedArtifactCount += 1;
      }
      const knownDirectories = [
        path.join(journal.staging_root, "media", "audio"),
        path.join(journal.staging_root, "media"),
        path.join(journal.staging_root, "sidecars"),
        path.join(journal.staging_root, "segments"),
        journal.staging_root,
      ];
      for (const directory of knownDirectories) {
        await fs.rmdir(directory).catch(() => undefined);
      }
      const result: Omit<DiscardInterruptedRecordingResultV1, "cached"> = {
        version: 1,
        journal_id: journal.journal_id,
        discarded: true,
        deleted_artifact_count: deletedArtifactCount,
      };
      journal.recovery_state = "discarded";
      journal.updated_at = new Date(this.#now()).toISOString();
      journal.receipt = {
        action: "discard",
        completed_at: journal.updated_at,
        result,
      };
      journal.receipt_expires_at = new Date(this.#now() + RECEIPT_TTL_MS).toISOString();
      await this.#persist(journal);
      await recordEngineLog({
        event: "recording.recovery.discarded",
        context: {
          request_id: String(request?.request_id ?? ""),
          session_id: journal.session_id,
          take_id: journal.take_id,
        },
        details: {
          cached: false,
          journal_id: journal.journal_id,
          deleted_artifact_count: deletedArtifactCount,
        },
      });
      return { ...result, cached: false };
    });
  }

  #recoverability(
    journal: RecordingSessionJournalV1,
  ): InterruptedRecordingSummaryV1["recoverability"] {
    if (journal.declared_artifacts.some((artifact) => artifact.kind === "video")) return "media";
    if (journal.declared_artifacts.some((artifact) => artifact.kind === "segment"))
      return "segments";
    return "diagnostic_only";
  }

  #forSession(sessionId: string): RecordingSessionJournalV1 | null {
    const id = this.#journalBySession.get(sessionId);
    return id ? (this.#journals.get(id) ?? null) : null;
  }

  #cachedReceipt<T extends "recover" | "discard">(
    journal: RecordingSessionJournalV1,
    action: T,
  ): T extends "recover"
    ? Omit<RecoverInterruptedRecordingResultV1, "cached"> | null
    : Omit<DiscardInterruptedRecordingResultV1, "cached"> | null {
    if (!journal.receipt) return null as never;
    if (journal.receipt.action !== action) {
      throw new Error(`recording journal already resolved by ${journal.receipt.action}`);
    }
    return journal.receipt.result as never;
  }

  #validateMutationRequest(
    request: { version?: unknown; journal_id?: unknown; request_id?: unknown } | undefined,
    command: string,
  ): void {
    if (request?.version !== 1) throw new Error(`${command} requires version 1`);
    if (typeof request.journal_id !== "string" || request.journal_id.length === 0) {
      throw new Error(`${command} requires journal_id`);
    }
    if (typeof request.request_id !== "string" || request.request_id.length === 0) {
      throw new Error(`${command} requires request_id`);
    }
  }

  async #persist(journal: RecordingSessionJournalV1): Promise<void> {
    await writeJsonAtomicDurable(path.join(this.root, `${journal.journal_id}.json`), journal);
  }

  async #withLock<T>(journalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(journalId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(journalId, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(journalId) === settled) this.#locks.delete(journalId);
    }
  }
}

export const recordingSessionJournal = new RecordingSessionJournalStore();

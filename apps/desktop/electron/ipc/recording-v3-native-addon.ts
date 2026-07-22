import { createRequire } from "node:module";
import path from "node:path";
import type { App } from "electron";
import { isPackagedRuntime } from "../runtime";
import {
  type RecordingFailureCodeV3,
  RECORDING_V3_DEVELOPMENT_DIMENSION_LIMITS,
} from "@storycapture/shared-types/recording-v3";

export const RECORDING_V3_NATIVE_PROTOCOL_VERSION = 3 as const;
export const RECORDING_V3_NATIVE_PROTOCOL_HASH =
  "f444d47f4f6d2cc71b709dc4677593e5047b8a61e34c76d7190fead3cf899c42" as const;
const ADDON_FILENAME = "storycapture_recording_v3.node";

export interface RecordingV3NativeProbe {
  protocolVersion: typeof RECORDING_V3_NATIVE_PROTOCOL_VERSION;
  protocolHash: typeof RECORDING_V3_NATIVE_PROTOCOL_HASH;
  ioSurface: true;
  nativeFfv1: true;
  maxQueuedLeases: number;
  maxCompletedReceipts: number;
}

export interface RecordingV3NativeFrameInput {
  ioSurface: Buffer;
  sourceEpoch: number;
  activeSegment: number;
  sourceFrameCount: number;
  sourceTimestampUs: number;
  activeTimePtsUs: number;
  deliveryOrdinal: number;
  nativeLeaseOrdinal: number;
}

export interface RecordingV3NativeReceipt {
  sourceEpoch: number;
  activeSegment: number;
  sourceFrameCount: number;
  sourceTimestampUs: number;
  activeTimePtsUs: number;
  deliveryOrdinal: number;
  nativeLeaseOrdinal: number;
  nativeCommitOrdinal: number;
  encodedOrdinal: number;
  bgraSha256: string;
  serviceTimeMs: number;
}

export interface RecordingV3NativeStats {
  handlesImported: number;
  handlesReleased: number;
  activeLeases: number;
  peakActiveLeases: number;
  deliveryFrames: number;
  nativeLeasesAccepted: number;
  nativeCommits: number;
  encodedFrames: number;
  leaseOverflows: number;
  leaseAdmissionWaits: number;
  leaseAdmissionWaitMaxMs: number;
  backpressureEvents: number;
  deadlineMisses: number;
  sourceOrdinalGaps: number;
  sourceTimestampRegressions: number;
  maxQueueDepth: number;
  maxReadyQueueDepth: number;
  boundedPoolBytes: number;
  serviceTimeP95Ms: number;
  serviceTimeP99Ms: number;
  serviceTimeMaxMs: number;
  ffmpegExitCode: number;
  failed: boolean;
  failureCode: string;
  failureReason: string;
}

export interface RecordingV3NativeTerminalResult {
  stats: RecordingV3NativeStats;
  receipts: RecordingV3NativeReceipt[];
}

export function recordingV3NativeDimensionsSupported(width: number, height: number): boolean {
  const limits = RECORDING_V3_DEVELOPMENT_DIMENSION_LIMITS;
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= limits.maximum_width &&
    height <= limits.maximum_height &&
    width * height <= limits.maximum_physical_pixels
  );
}

interface RawRecordingV3NativeSession {
  submit(input: RecordingV3NativeFrameInput): { nativeLeaseOrdinal: number };
  pause(): RecordingV3NativeStats;
  resume(input: { sourceEpoch: number; activeSegment: number }): RecordingV3NativeStats;
  closeEpoch(input: { sourceEpoch: number; activeSegment: number }): RecordingV3NativeStats;
  drainReceipts(): RecordingV3NativeReceipt[];
  stop(): RecordingV3NativeTerminalResult;
  abort(): RecordingV3NativeTerminalResult;
  getStats(): RecordingV3NativeStats;
}

interface RawRecordingV3NativeAddon {
  protocolVersion: number;
  protocolHash: string;
  probe(): RecordingV3NativeProbe;
  start(input: {
    width: number;
    height: number;
    ffmpegPath: string;
    outputPath: string;
  }): RawRecordingV3NativeSession;
}

const NATIVE_FAILURE_CODES = new Set<RecordingFailureCodeV3>([
  "source_ordinal_gap",
  "source_timestamp_regression",
  "source_epoch_violation",
  "active_segment_violation",
  "native_lease_overflow",
  "native_backpressure",
  "native_deadline_missed",
  "native_texture_lost",
  "native_addon_crashed",
  "native_encoder_exit_nonzero",
  "addon_load_failed",
  "addon_protocol_mismatch",
  "contract_mismatch",
]);

function failureCodeFromError(error: unknown): RecordingFailureCodeV3 {
  const rawCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (NATIVE_FAILURE_CODES.has(rawCode as RecordingFailureCodeV3)) {
    return rawCode as RecordingFailureCodeV3;
  }
  const message = error instanceof Error ? error.message : String(error);
  const prefix = message.split(":", 1)[0] ?? "";
  return NATIVE_FAILURE_CODES.has(prefix as RecordingFailureCodeV3)
    ? (prefix as RecordingFailureCodeV3)
    : "native_addon_crashed";
}

export class RecordingV3NativeError extends Error {
  constructor(
    readonly code: RecordingFailureCodeV3,
    message: string,
    readonly terminalResult: RecordingV3NativeTerminalResult | null = null,
  ) {
    super(message);
    this.name = "RecordingV3NativeError";
  }
}

function nativeCall<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    throw new RecordingV3NativeError(
      failureCodeFromError(error),
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isSafeOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readReceipt(value: unknown): RecordingV3NativeReceipt {
  if (typeof value !== "object" || value === null) {
    throw new RecordingV3NativeError("native_addon_crashed", "native receipt was not an object");
  }
  const receipt = value as Partial<RecordingV3NativeReceipt>;
  const ordinals = [
    receipt.sourceEpoch,
    receipt.activeSegment,
    receipt.sourceFrameCount,
    receipt.sourceTimestampUs,
    receipt.activeTimePtsUs,
    receipt.deliveryOrdinal,
    receipt.nativeLeaseOrdinal,
    receipt.nativeCommitOrdinal,
    receipt.encodedOrdinal,
  ];
  if (
    !ordinals.every(isSafeOrdinal) ||
    typeof receipt.bgraSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.bgraSha256) ||
    typeof receipt.serviceTimeMs !== "number" ||
    !Number.isFinite(receipt.serviceTimeMs) ||
    receipt.serviceTimeMs < 0
  ) {
    throw new RecordingV3NativeError("native_addon_crashed", "native receipt violated protocol");
  }
  return receipt as RecordingV3NativeReceipt;
}

function readReceipts(values: unknown): RecordingV3NativeReceipt[] {
  if (!Array.isArray(values)) {
    throw new RecordingV3NativeError("native_addon_crashed", "native receipts were not an array");
  }
  return values.map(readReceipt);
}

function validateStats(stats: RecordingV3NativeStats): RecordingV3NativeStats {
  const counts = [
    stats.handlesImported,
    stats.handlesReleased,
    stats.activeLeases,
    stats.peakActiveLeases,
    stats.deliveryFrames,
    stats.nativeLeasesAccepted,
    stats.nativeCommits,
    stats.encodedFrames,
    stats.leaseOverflows,
    stats.leaseAdmissionWaits,
    stats.backpressureEvents,
    stats.deadlineMisses,
    stats.sourceOrdinalGaps,
    stats.sourceTimestampRegressions,
    stats.maxQueueDepth,
    stats.maxReadyQueueDepth,
    stats.boundedPoolBytes,
  ];
  if (
    !counts.every(isSafeOrdinal) ||
    typeof stats.leaseAdmissionWaitMaxMs !== "number" ||
    !Number.isFinite(stats.leaseAdmissionWaitMaxMs) ||
    stats.leaseAdmissionWaitMaxMs < 0 ||
    typeof stats.failed !== "boolean" ||
    typeof stats.failureCode !== "string" ||
    typeof stats.failureReason !== "string"
  ) {
    throw new RecordingV3NativeError("native_addon_crashed", "native stats violated protocol");
  }
  return stats;
}

export function recordingV3NativeAddonPath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  desktopRoot: string;
}): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "macos", ADDON_FILENAME)
    : path.join(input.desktopRoot, "native", "macos-recording-v3", ".build", ADDON_FILENAME);
}

export function recordingV3NativeAddonPathForRuntime(input: {
  app: Pick<App, "isPackaged">;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  resourcesPath: string;
  desktopRoot: string;
}): string {
  return recordingV3NativeAddonPath({
    isPackaged: isPackagedRuntime(input.app, input.env, input.executablePath),
    resourcesPath: input.resourcesPath,
    desktopRoot: input.desktopRoot,
  });
}

export function loadRecordingV3NativeAddon(addonPath: string): RawRecordingV3NativeAddon {
  let addon: Partial<RawRecordingV3NativeAddon>;
  try {
    addon = createRequire(import.meta.url)(addonPath) as Partial<RawRecordingV3NativeAddon>;
  } catch (error) {
    throw new RecordingV3NativeError(
      "addon_load_failed",
      `failed to load Recording V3 addon at ${addonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    addon.protocolVersion !== RECORDING_V3_NATIVE_PROTOCOL_VERSION ||
    addon.protocolHash !== RECORDING_V3_NATIVE_PROTOCOL_HASH ||
    typeof addon.probe !== "function" ||
    typeof addon.start !== "function"
  ) {
    throw new RecordingV3NativeError(
      "addon_protocol_mismatch",
      `unsupported Recording V3 addon protocol at ${addonPath}`,
    );
  }
  return addon as RawRecordingV3NativeAddon;
}

export function probeRecordingV3NativeAddon(
  addon: RawRecordingV3NativeAddon,
): RecordingV3NativeProbe {
  const probe = nativeCall(() => addon.probe());
  if (
    probe.protocolVersion !== RECORDING_V3_NATIVE_PROTOCOL_VERSION ||
    probe.protocolHash !== RECORDING_V3_NATIVE_PROTOCOL_HASH ||
    probe.ioSurface !== true ||
    probe.nativeFfv1 !== true ||
    probe.maxQueuedLeases !== 1 ||
    probe.maxCompletedReceipts < 2
  ) {
    throw new RecordingV3NativeError(
      "addon_protocol_mismatch",
      "Recording V3 addon capability probe did not match the certified protocol",
    );
  }
  return probe;
}

export class RecordingV3NativeSession {
  private terminalResult: RecordingV3NativeTerminalResult | null = null;

  constructor(private readonly session: RawRecordingV3NativeSession) {}

  submit(input: RecordingV3NativeFrameInput): {
    nativeLeaseOrdinal: number;
    completedReceipts: RecordingV3NativeReceipt[];
  } {
    if (this.terminalResult) {
      throw new RecordingV3NativeError("contract_mismatch", "native session is terminal");
    }
    const accepted = nativeCall(() => this.session.submit(input));
    if (!isSafeOrdinal(accepted.nativeLeaseOrdinal)) {
      throw new RecordingV3NativeError("native_addon_crashed", "native lease ordinal was invalid");
    }
    return {
      nativeLeaseOrdinal: accepted.nativeLeaseOrdinal,
      completedReceipts: this.drainReceipts(),
    };
  }

  pause(): RecordingV3NativeStats {
    return validateStats(nativeCall(() => this.session.pause()));
  }

  resume(input: { sourceEpoch: number; activeSegment: number }): RecordingV3NativeStats {
    return validateStats(nativeCall(() => this.session.resume(input)));
  }

  closeEpoch(input: { sourceEpoch: number; activeSegment: number }): RecordingV3NativeStats {
    return validateStats(nativeCall(() => this.session.closeEpoch(input)));
  }

  drainReceipts(): RecordingV3NativeReceipt[] {
    return readReceipts(nativeCall(() => this.session.drainReceipts()));
  }

  getStats(): RecordingV3NativeStats {
    return validateStats(nativeCall(() => this.session.getStats()));
  }

  stop(): RecordingV3NativeTerminalResult {
    if (this.terminalResult) return this.terminalResult;
    const raw = nativeCall(() => this.session.stop());
    const terminal = {
      stats: validateStats(raw.stats),
      receipts: readReceipts(raw.receipts),
    };
    this.terminalResult = terminal;
    if (terminal.stats.failed) {
      throw new RecordingV3NativeError(
        failureCodeFromError({ code: terminal.stats.failureCode }),
        terminal.stats.failureReason,
        terminal,
      );
    }
    return terminal;
  }

  abort(): RecordingV3NativeTerminalResult {
    if (this.terminalResult) return this.terminalResult;
    const raw = nativeCall(() => this.session.abort());
    this.terminalResult = {
      stats: validateStats(raw.stats),
      receipts: readReceipts(raw.receipts),
    };
    return this.terminalResult;
  }
}

export class RecordingV3NativeBridge {
  constructor(private readonly addon: RawRecordingV3NativeAddon) {}

  probe(): RecordingV3NativeProbe {
    return probeRecordingV3NativeAddon(this.addon);
  }

  start(input: {
    width: number;
    height: number;
    ffmpegPath: string;
    outputPath: string;
  }): RecordingV3NativeSession {
    this.probe();
    if (!recordingV3NativeDimensionsSupported(input.width, input.height)) {
      throw new RecordingV3NativeError(
        "contract_mismatch",
        `Recording V3 native dimensions must be positive integers within ${RECORDING_V3_DEVELOPMENT_DIMENSION_LIMITS.maximum_width}x${RECORDING_V3_DEVELOPMENT_DIMENSION_LIMITS.maximum_height} and ${RECORDING_V3_DEVELOPMENT_DIMENSION_LIMITS.maximum_physical_pixels} pixels; received ${input.width}x${input.height}`,
      );
    }
    return new RecordingV3NativeSession(nativeCall(() => this.addon.start(input)));
  }
}

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type {
  CaptureBackendV2,
  CaptureBackendV2Capabilities,
  CaptureBackendV2Frame,
  CaptureBackendV2SessionStart,
  RecordingPreflightV2Dto,
  RecordingPreflightV2Request,
  RecordingQualityFailureCode,
  RecordingStorageEstimateV2,
} from "@storycapture/shared-types/recording-v2";
import { CaptureBackendV2Error, CaptureBackendV2Guard } from "./capture-backend-v2-guard";
import { recordingCertificationTierMatches } from "./recording-certification-catalog";
import type { RecordingFrameInput } from "./recording-frame-ring";

export const MACOS_SCREEN_CAPTURE_BACKEND_ID = "screen-capture-kit";
export const MACOS_SCREEN_CAPTURE_BACKEND_VERSION = "2.0.0";
const MACOS_SCREEN_CAPTURE_CAPABILITIES: CaptureBackendV2Capabilities = {
  version: 2,
  backend_id: MACOS_SCREEN_CAPTURE_BACKEND_ID,
  backend_version: MACOS_SCREEN_CAPTURE_BACKEND_VERSION,
  target_classes: ["display", "window"],
  supports_native_timestamps: true,
  supports_source_sequences: true,
  supports_physical_pixels: true,
  supports_cursor_policy: true,
  supports_pause_resume: true,
};
const NATIVE_PACKET_MAGIC = Buffer.from([0x53, 0x43, 0x46, 0x52, 0x4d, 0x32, 0, 0]);
const NATIVE_PACKET_HEADER_BYTES = 64;
const MAX_NATIVE_PACKET_BYTES = 512 * 1024 * 1024;
const MAC_BACKEND_FAILURE_CODES = new Set<RecordingQualityFailureCode>([
  "source_rate_mismatch",
  "source_sequence_missing",
  "source_sequence_gap",
  "source_stale_reuse",
  "submitted_frame_dropped",
  "frame_ring_overflow",
  "storage_reserve_exhausted",
  "backend_unavailable",
  "backend_capability_mismatch",
  "permission_denied",
  "target_missing",
  "target_ambiguous",
  "target_changed",
  "target_lost",
  "artifact_pts_gap",
  "artifact_pts_duplicate",
  "verification_timeout",
  "contract_mismatch",
]);

export interface MacScreenCaptureTarget {
  kind: "display" | "window";
  displayID?: number;
  windowID?: number;
  ownerPID?: number;
  ownerBundleID?: string;
  expectedIdentity?: string;
}

export interface MacScreenCapturePacket {
  kind: "video" | "system_audio";
  sequence: number;
  nativePtsUs: number;
  width: number;
  height: number;
  stride: number;
  format: number;
  flags: bigint;
  bytes: Uint8Array;
}

export interface MacScreenCaptureSink {
  submit(frame: RecordingFrameInput): Promise<void>;
  systemAudioPacket?(packet: MacScreenCapturePacket): Promise<void> | void;
  failed?(code: RecordingQualityFailureCode, message: string): void;
}

export interface MacScreenCapturePreflightContext {
  storage: RecordingStorageEstimateV2;
  encodeThroughputRatio: number;
  gpuIdentity: string | null;
}

interface HelperResponse {
  version: number;
  request_id?: string;
  event: string;
  ok: boolean;
  code?: RecordingQualityFailureCode;
  message?: string;
  data?: Record<string, unknown>;
}

interface HelperProbeData extends Record<string, unknown> {
  backend_id: string;
  backend_version: string;
  platform: "darwin";
  arch: string;
  hardware_fingerprint: string;
  target_identity: string;
  permissions_granted: boolean;
  measured_fps: { numerator: number; denominator: number } | null;
  source_presentations: number;
  sequence_gaps: number;
  stale_reuses: number;
  probe_duration_ms: number;
  logical_width: number;
  logical_height: number;
  physical_width: number;
  physical_height: number;
}

export interface MacScreenCaptureHelperTransport {
  request(
    command: "hello" | "probe" | "start" | "pause" | "resume" | "stop" | "shutdown",
    options?: { sessionID?: string; payload?: Record<string, unknown> },
  ): Promise<HelperResponse>;
  close(): void;
}

export interface MacScreenCaptureBackendOptions {
  target: MacScreenCaptureTarget;
  sink: MacScreenCaptureSink;
  preflight: MacScreenCapturePreflightContext;
  helperPath: string;
  arch?: string;
  showsCursor?: boolean;
  dynamicSizePolicy?: "fail_on_change" | "scale_to_contract";
  probeDurationMs?: number;
  transportFactory?: (
    helperPath: string,
    onPacket: (packet: MacScreenCapturePacket) => Promise<void>,
    onFailure: (code: RecordingQualityFailureCode, message: string) => void,
  ) => MacScreenCaptureHelperTransport;
}

export function resolveMacScreenCaptureHelperPath({
  isPackaged,
  resourcesPath,
  appPath,
}: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return isPackaged
    ? path.join(resourcesPath, "native", "macos", "storycapture-screen-capture-helper")
    : path.join(
        appPath,
        "native",
        "macos-screen-capture",
        ".build",
        "release",
        "storycapture-screen-capture-helper",
      );
}

function asSafeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new CaptureBackendV2Error("contract_mismatch", `${field} exceeds the safe integer range`);
  }
  return number;
}

export class MacNativePacketDecoder {
  private readonly chunks: Buffer[] = [];
  private headOffset = 0;
  private available = 0;

  push(chunk: Uint8Array): MacScreenCapturePacket[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
      this.available += chunk.byteLength;
    }
    const packets: MacScreenCapturePacket[] = [];
    while (this.available >= NATIVE_PACKET_HEADER_BYTES) {
      const header = this.peek(NATIVE_PACKET_HEADER_BYTES);
      if (!header.subarray(0, 8).equals(NATIVE_PACKET_MAGIC)) {
        throw new CaptureBackendV2Error("contract_mismatch", "native packet magic is invalid");
      }
      const headerBytes = header.readUInt32LE(12);
      if (headerBytes !== NATIVE_PACKET_HEADER_BYTES) {
        throw new CaptureBackendV2Error(
          "contract_mismatch",
          "native packet header size is invalid",
        );
      }
      const payloadBytes = asSafeNumber(header.readBigUInt64LE(48), "payload size");
      if (payloadBytes < 0 || payloadBytes > MAX_NATIVE_PACKET_BYTES) {
        throw new CaptureBackendV2Error("contract_mismatch", "native packet payload is invalid");
      }
      const packetBytes = headerBytes + payloadBytes;
      if (this.available < packetBytes) break;
      const kindValue = header.readUInt32LE(8);
      if (kindValue !== 1 && kindValue !== 2) {
        throw new CaptureBackendV2Error("contract_mismatch", "native packet kind is invalid");
      }
      this.consume(headerBytes);
      packets.push({
        kind: kindValue === 1 ? "video" : "system_audio",
        sequence: asSafeNumber(header.readBigUInt64LE(16), "packet sequence"),
        nativePtsUs: asSafeNumber(header.readBigUInt64LE(24), "native PTS"),
        width: header.readUInt32LE(32),
        height: header.readUInt32LE(36),
        stride: header.readUInt32LE(40),
        format: header.readUInt32LE(44),
        flags: header.readBigUInt64LE(56),
        bytes: new Uint8Array(this.consume(payloadBytes)),
      });
    }
    return packets;
  }

  finish(): void {
    if (this.available !== 0) {
      throw new CaptureBackendV2Error("contract_mismatch", "native frame channel ended mid-packet");
    }
  }

  private peek(bytes: number): Buffer {
    if (this.chunks[0] && this.chunks[0].byteLength - this.headOffset >= bytes) {
      return this.chunks[0].subarray(this.headOffset, this.headOffset + bytes);
    }
    const value = Buffer.allocUnsafe(bytes);
    let written = 0;
    let offset = this.headOffset;
    for (const chunk of this.chunks) {
      const count = Math.min(bytes - written, chunk.byteLength - offset);
      chunk.copy(value, written, offset, offset + count);
      written += count;
      if (written === bytes) break;
      offset = 0;
    }
    return value;
  }

  private consume(bytes: number): Buffer {
    if (bytes === 0) return Buffer.alloc(0);
    const contiguous = this.chunks[0];
    if (contiguous && contiguous.byteLength - this.headOffset >= bytes) {
      const value = contiguous.subarray(this.headOffset, this.headOffset + bytes);
      this.headOffset += bytes;
      this.available -= bytes;
      if (this.headOffset === contiguous.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
      return value;
    }
    const value = Buffer.allocUnsafe(bytes);
    let written = 0;
    while (written < bytes) {
      const chunk = this.chunks[0];
      if (!chunk) throw new Error("native packet decoder underflow");
      const count = Math.min(bytes - written, chunk.byteLength - this.headOffset);
      chunk.copy(value, written, this.headOffset, this.headOffset + count);
      written += count;
      this.headOffset += count;
      this.available -= count;
      if (this.headOffset === chunk.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    return value;
  }
}

class MacScreenCaptureHelperError extends Error {
  constructor(
    readonly code: RecordingQualityFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "MacScreenCaptureHelperError";
  }
}

class MacScreenCaptureHelperProcess implements MacScreenCaptureHelperTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      resolve: (response: HelperResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly packetDecoder = new MacNativePacketDecoder();
  private nextRequest = 0;
  private closed = false;

  constructor(
    helperPath: string,
    onPacket: (packet: MacScreenCapturePacket) => Promise<void>,
    onFailure: (code: RecordingQualityFailureCode, message: string) => void,
  ) {
    this.child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const packetStream = this.child.stdio[3] as Readable | null;
    if (!packetStream) {
      this.child.kill("SIGKILL");
      throw new MacScreenCaptureHelperError(
        "backend_unavailable",
        "ScreenCaptureKit helper frame channel is unavailable",
      );
    }
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let response: HelperResponse;
      try {
        response = JSON.parse(line) as HelperResponse;
      } catch {
        onFailure("contract_mismatch", "ScreenCaptureKit helper emitted invalid JSON");
        return;
      }
      if (!response.request_id) {
        if (!response.ok) {
          onFailure(
            readFailureCode(response.code, "contract_mismatch"),
            response.message ?? response.event,
          );
        }
        return;
      }
      const request = this.pending.get(response.request_id);
      if (!request) return;
      this.pending.delete(response.request_id);
      clearTimeout(request.timeout);
      if (response.ok) request.resolve(response);
      else {
        request.reject(
          new MacScreenCaptureHelperError(
            readFailureCode(response.code, "contract_mismatch"),
            response.message ?? response.event,
          ),
        );
      }
    });
    packetStream.on("data", (chunk: Buffer) => {
      packetStream.pause();
      void (async () => {
        try {
          for (const packet of this.packetDecoder.push(chunk)) await onPacket(packet);
        } catch (error) {
          const failure =
            error instanceof CaptureBackendV2Error
              ? error
              : new CaptureBackendV2Error(failureCode(error), String(error));
          onFailure(failure.code, failure.message);
        } finally {
          packetStream.resume();
        }
      })();
    });
    packetStream.on("end", () => {
      try {
        this.packetDecoder.finish();
      } catch (error) {
        onFailure("contract_mismatch", String(error));
      }
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closed) {
        const message = `ScreenCaptureKit helper exited (${code ?? signal ?? "unknown"})`;
        this.failAll(new MacScreenCaptureHelperError("backend_unavailable", message));
        onFailure("backend_unavailable", message);
      }
    });
  }

  request(
    command: "hello" | "probe" | "start" | "pause" | "resume" | "stop" | "shutdown",
    options: { sessionID?: string; payload?: Record<string, unknown> } = {},
  ): Promise<HelperResponse> {
    if (this.closed) {
      return Promise.reject(
        new MacScreenCaptureHelperError("backend_unavailable", "ScreenCaptureKit helper is closed"),
      );
    }
    const requestID = `mac-helper-${++this.nextRequest}`;
    const operation = new Promise<HelperResponse>((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(requestID);
          reject(
            new MacScreenCaptureHelperError(
              "verification_timeout",
              `ScreenCaptureKit helper ${command} timed out`,
            ),
          );
        },
        command === "probe" ? 15_000 : 5_000,
      );
      this.pending.set(requestID, { resolve, reject, timeout });
    });
    const commandValue = JSON.stringify({
      version: 2,
      request_id: requestID,
      command,
      ...(options.sessionID ? { session_id: options.sessionID } : {}),
      ...(options.payload ? { payload: options.payload } : {}),
    });
    this.child.stdin.write(`${commandValue}\n`, (error) => {
      if (!error) return;
      const pending = this.pending.get(requestID);
      this.pending.delete(requestID);
      if (pending) clearTimeout(pending.timeout);
      pending?.reject(error);
    });
    return operation;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGKILL");
    this.failAll(new MacScreenCaptureHelperError("backend_unavailable", "helper closed"));
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function helperPayload(
  request: RecordingPreflightV2Request,
  target: MacScreenCaptureTarget,
  options: MacScreenCaptureBackendOptions,
): Record<string, unknown> {
  return {
    target,
    outputWidth: request.dimensions.physical_width,
    outputHeight: request.dimensions.physical_height,
    expectedLogicalWidth: request.dimensions.logical_width,
    expectedLogicalHeight: request.dimensions.logical_height,
    showsCursor: options.showsCursor ?? true,
    dynamicSizePolicy: options.dynamicSizePolicy ?? "fail_on_change",
    capturesSystemAudio: request.audio_roles.includes("system"),
    probeDurationMS: options.probeDurationMs ?? 5_000,
  };
}

function failureCode(error: unknown): RecordingQualityFailureCode {
  if (error instanceof MacScreenCaptureHelperError || error instanceof CaptureBackendV2Error) {
    return error.code;
  }
  if (error && typeof error === "object" && "code" in error) {
    return readFailureCode((error as { code?: unknown }).code, "backend_unavailable");
  }
  return "backend_unavailable";
}

function readFailureCode(
  value: unknown,
  fallback: RecordingQualityFailureCode,
): RecordingQualityFailureCode {
  return typeof value === "string" &&
    MAC_BACKEND_FAILURE_CODES.has(value as RecordingQualityFailureCode)
    ? (value as RecordingQualityFailureCode)
    : fallback;
}

function matchesCertification(
  request: RecordingPreflightV2Request,
  data: HelperProbeData,
): boolean {
  return recordingCertificationTierMatches(request.desired_tier, {
    platform: "darwin",
    arch: data.arch,
    hardwareFingerprint: data.hardware_fingerprint,
    targetClass: request.target_class,
    capabilities: MACOS_SCREEN_CAPTURE_CAPABILITIES,
    outputWidth: request.dimensions.requested_output_width,
    outputHeight: request.dimensions.requested_output_height,
  });
}

function tightBGRA(packet: MacScreenCapturePacket): Uint8Array {
  const tightStride = packet.width * 4;
  if (packet.stride < tightStride || packet.bytes.byteLength !== packet.stride * packet.height) {
    throw new CaptureBackendV2Error("contract_mismatch", "native BGRA packet has invalid stride");
  }
  if (packet.stride === tightStride) return packet.bytes;
  const pixels = new Uint8Array(tightStride * packet.height);
  for (let row = 0; row < packet.height; row += 1) {
    pixels.set(
      packet.bytes.subarray(row * packet.stride, row * packet.stride + tightStride),
      row * tightStride,
    );
  }
  return pixels;
}

export class MacOSScreenCaptureBackend implements CaptureBackendV2 {
  readonly capabilities = MACOS_SCREEN_CAPTURE_CAPABILITIES;

  private readonly guard = new CaptureBackendV2Guard(this.capabilities);
  private readonly transport: MacScreenCaptureHelperTransport;
  private probeIdentity: string | null = null;

  constructor(private readonly options: MacScreenCaptureBackendOptions) {
    const factory =
      options.transportFactory ??
      ((helperPath, onPacket, onFailure) =>
        new MacScreenCaptureHelperProcess(helperPath, onPacket, onFailure));
    this.transport = factory(
      options.helperPath,
      (packet) => this.deliver(packet),
      (code, message) => this.handleFailure(code, message),
    );
  }

  async probe(request: RecordingPreflightV2Request): Promise<RecordingPreflightV2Dto> {
    let data: HelperProbeData | null = null;
    const failures: RecordingQualityFailureCode[] = [];
    try {
      const response = await this.transport.request("probe", {
        payload: helperPayload(request, this.options.target, this.options),
      });
      data = response.data as HelperProbeData;
      this.probeIdentity = data.target_identity;
      if (
        data.logical_width !== request.dimensions.logical_width ||
        data.logical_height !== request.dimensions.logical_height ||
        data.physical_width !== request.dimensions.physical_width ||
        data.physical_height !== request.dimensions.physical_height
      ) {
        failures.push("target_changed");
      }
    } catch (error) {
      failures.push(failureCode(error));
    }
    const certificationMatch = data ? matchesCertification(request, data) : false;
    const result: RecordingPreflightV2Dto = {
      version: 2,
      backend_id: MACOS_SCREEN_CAPTURE_BACKEND_ID,
      backend_version: MACOS_SCREEN_CAPTURE_BACKEND_VERSION,
      platform: "darwin",
      arch: data?.arch ?? this.options.arch ?? process.arch,
      gpu_identity: this.options.preflight.gpuIdentity,
      hardware_fingerprint: data?.hardware_fingerprint ?? "unavailable",
      certification: certificationMatch ? request.desired_tier : null,
      certification_match: certificationMatch,
      source_rate: {
        measured_fps: data?.measured_fps ?? null,
        source_presentations: data?.source_presentations ?? 0,
        sequence_gaps: data?.sequence_gaps ?? 0,
        stale_reuses: data?.stale_reuses ?? 0,
        probe_duration_ms: data?.probe_duration_ms ?? 0,
      },
      encode_throughput_ratio: this.options.preflight.encodeThroughputRatio,
      storage: this.options.preflight.storage,
      permissions_granted: data?.permissions_granted ?? false,
      strict_eligible: false,
      failure_codes: failures,
    };
    return this.guard.acceptProbe(request, result);
  }

  async start(start: CaptureBackendV2SessionStart): Promise<void> {
    this.guard.begin(start);
    const target = { ...this.options.target, expectedIdentity: this.probeIdentity ?? undefined };
    try {
      await this.transport.request("start", {
        sessionID: start.session_id,
        payload: helperPayload(start.request, target, this.options),
      });
    } catch (error) {
      throw this.guard.fail(failureCode(error), String(error));
    }
  }

  async pause(): Promise<void> {
    await this.transport.request("pause");
    this.guard.pause();
  }

  async resume(): Promise<void> {
    this.guard.resume();
    try {
      await this.transport.request("resume");
    } catch (error) {
      throw this.guard.fail(failureCode(error), String(error));
    }
  }

  async stop(): Promise<void> {
    if (this.guard.lifecycle === "stopped") return;
    try {
      await this.transport.request("stop");
      this.guard.stop();
      await this.transport.request("shutdown");
    } finally {
      this.transport.close();
    }
  }

  private async deliver(packet: MacScreenCapturePacket): Promise<void> {
    if (packet.kind === "system_audio") {
      await this.options.sink.systemAudioPacket?.(packet);
      return;
    }
    if (packet.format !== 1) {
      throw this.guard.fail("contract_mismatch", "native helper did not deliver BGRA pixels");
    }
    const pixels = tightBGRA(packet);
    const frame: CaptureBackendV2Frame = {
      source_sequence: packet.sequence,
      native_pts_us: packet.nativePtsUs,
      width: packet.width,
      height: packet.height,
      stride: packet.width * 4,
      pixel_format: "bgra",
    };
    this.guard.acceptFrame(frame);
    await this.options.sink.submit({
      sourceSequence: frame.source_sequence,
      nativePtsUs: frame.native_pts_us,
      pixels,
    });
  }

  private handleFailure(code: RecordingQualityFailureCode, message: string): void {
    this.guard.fail(code, message);
    this.options.sink.failed?.(code, message);
  }
}

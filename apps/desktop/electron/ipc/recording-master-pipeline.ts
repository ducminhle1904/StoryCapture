import fs from "node:fs/promises";
import path from "node:path";
import type {
  RecordingBundleV2,
  RecordingCadenceEvidenceV2,
  RecordingCaptureContractV2,
  RecordingCertifiedTier,
  RecordingDeliveryPolicy,
  RecordingQualityEvidenceDto,
  RecordingQualityFailureCode,
  RecordingResultV2,
} from "@storycapture/shared-types/recording-v2";
import { probeRecording } from "./media-probe";
import {
  hasLiveRecordingReserve,
  RecordingBundleWorkspace,
  RecordingSequenceLedger,
  recordingBundleArtifact,
  recordingStoragePreflight,
} from "./recording-bundle";
import {
  applyProbeToCadenceObservation,
  verifyRecordingCadence,
} from "./recording-cadence-verifier";
import { BoundedNativeFrameRing, type RecordingFrameInput } from "./recording-frame-ring";
import {
  type PcmWavInput,
  RecordingMasterEncoder,
  transcodeAudioFileToPcmWav,
  verifyMasterAndCreateProxy,
  writePcmWav,
} from "./recording-master";
import { exactLosslessMasterQualityEvidence } from "./recording-quality-verifier";

export interface StrictRecordingMasterPipelineOptions {
  exportsDir: string;
  name: string;
  width: number;
  height: number;
  captureContract: RecordingCaptureContractV2;
  deliveryPolicy: RecordingDeliveryPolicy;
  certifiedTier: RecordingCertifiedTier | null;
  ringCapacity?: number;
}

export interface StrictRecordingFinalizeInput {
  cadenceEvidence: RecordingCadenceEvidenceV2;
  qualityEvidence?: RecordingQualityEvidenceDto;
  actionsPath?: string | null;
}

/** Common master sink consumed by browser and native CaptureBackendV2 adapters. */
export class StrictRecordingMasterPipeline {
  readonly ring: BoundedNativeFrameRing;
  readonly ledger = new RecordingSequenceLedger();
  readonly workspace: RecordingBundleWorkspace;
  readonly masterPath: string;
  readonly proxyPath: string;

  private readonly encoder: RecordingMasterEncoder;
  private queue = Promise.resolve();
  private stickyFailure: Error | null = null;
  private submittedFrames = 0;
  private estimatedBytesPerSecond: number;
  private readonly audioRoles = new Set<"microphone" | "system">();

  private constructor(
    readonly options: StrictRecordingMasterPipelineOptions,
    workspace: RecordingBundleWorkspace,
    estimatedBytesPerSecond: number,
  ) {
    this.workspace = workspace;
    this.masterPath = workspace.resolve("master/video.mkv");
    this.proxyPath = workspace.resolve("proxy/video.mp4");
    this.ring = new BoundedNativeFrameRing(
      options.width,
      options.height,
      options.ringCapacity ?? 8,
    );
    this.encoder = new RecordingMasterEncoder(options.width, options.height, this.masterPath);
    this.estimatedBytesPerSecond = estimatedBytesPerSecond;
    this.encoder.start();
  }

  static async create(
    options: StrictRecordingMasterPipelineOptions,
  ): Promise<StrictRecordingMasterPipeline> {
    if (options.deliveryPolicy !== "strict") {
      throw new Error("Strict recording master pipeline requires the strict delivery policy");
    }
    const storage = await recordingStoragePreflight(options.exportsDir, {
      width: options.width,
      height: options.height,
      fps: 60,
    });
    if (!storage.eligible)
      throw new Error("storage reserve is insufficient for a ten-minute FFV1 take");
    const workspace = await RecordingBundleWorkspace.create(options.exportsDir, options.name);
    try {
      return new StrictRecordingMasterPipeline(
        options,
        workspace,
        storage.estimated_bytes_per_second,
      );
    } catch (error) {
      await workspace.discard();
      throw error;
    }
  }

  submit(frame: RecordingFrameInput): Promise<void> {
    if (this.stickyFailure) return Promise.reject(this.stickyFailure);
    try {
      this.ledger.append(this.ring.push(frame));
    } catch (error) {
      this.stickyFailure = error instanceof Error ? error : new Error(String(error));
      return Promise.reject(this.stickyFailure);
    }
    const submittedFrameNumber = ++this.submittedFrames;
    const operation = this.queue.then(async () => {
      if (submittedFrameNumber % 60 === 0) {
        const reserve = await hasLiveRecordingReserve(
          this.options.exportsDir,
          this.estimatedBytesPerSecond,
        );
        if (!reserve) throw new Error("storage reserve dropped below two estimated minutes");
      }
      const lease = this.ring.take();
      if (!lease) throw new Error("recording frame ring lost a submitted frame");
      try {
        await this.encoder.writeFrame(lease.pixels);
      } finally {
        lease.release();
      }
    });
    this.queue = operation.catch((error) => {
      this.stickyFailure = error instanceof Error ? error : new Error(String(error));
    });
    return operation;
  }

  async writeAudioSidecar(role: "microphone" | "system", input: PcmWavInput): Promise<void> {
    if (this.audioRoles.has(role))
      throw new Error(`recording ${role} audio sidecar already exists`);
    await writePcmWav(this.workspace.resolve(`audio/${role}.wav`), input);
    this.audioRoles.add(role);
  }

  async writeAudioFileSidecar(role: "microphone" | "system", inputPath: string): Promise<void> {
    if (this.audioRoles.has(role))
      throw new Error(`recording ${role} audio sidecar already exists`);
    await transcodeAudioFileToPcmWav(inputPath, this.workspace.resolve(`audio/${role}.wav`));
    this.audioRoles.add(role);
  }

  async finalize(input: StrictRecordingFinalizeInput): Promise<RecordingResultV2> {
    await this.queue;
    const ledger = this.ledger.snapshot();
    const suppliedQuality = input.qualityEvidence;
    const qualityFailures = [...(suppliedQuality?.failure_codes ?? [])];
    const addQualityFailure = (code: RecordingQualityFailureCode) => {
      if (!qualityFailures.includes(code)) qualityFailures.push(code);
    };
    let encoderClosed = false;
    try {
      if (this.stickyFailure) throw this.stickyFailure;
      await this.encoder.close();
      encoderClosed = true;
    } catch {
      addQualityFailure("submitted_frame_dropped");
      this.encoder.abort();
    }
    await this.ledger.writeJsonLines(this.workspace.resolve("evidence/sequence-ledger.jsonl"));
    let masterHashesMatch = false;
    if (encoderClosed) {
      try {
        await verifyMasterAndCreateProxy({
          masterPath: this.masterPath,
          proxyPath: this.proxyPath,
          width: this.options.width,
          height: this.options.height,
          ledger,
        });
        masterHashesMatch = true;
      } catch (error) {
        addQualityFailure(
          error instanceof Error && error.message.includes("hash mismatch")
            ? "artifact_hash_mismatch"
            : "artifact_decode_failed",
        );
        await fs.rm(this.proxyPath, { force: true });
      }
    } else {
      addQualityFailure("artifact_decode_failed");
    }
    if (suppliedQuality?.lossless_master_hashes_match === false) {
      addQualityFailure("artifact_hash_mismatch");
    }
    const masterProbe = await probeRecording(this.masterPath, {
      verifiedFullDecode: masterHashesMatch,
    });
    const cadenceEvidence = verifyRecordingCadence(
      applyProbeToCadenceObservation(input.cadenceEvidence, masterProbe, {
        width: this.options.width,
        height: this.options.height,
        codec: "ffv1",
      }),
    );
    let actionsRelativePath: "sidecars/actions.json" | null = null;
    if (input.actionsPath) {
      try {
        actionsRelativePath = "sidecars/actions.json";
        await fs.copyFile(input.actionsPath, this.workspace.resolve(actionsRelativePath));
      } catch {
        actionsRelativePath = null;
        addQualityFailure("contract_mismatch");
      }
    }
    const qualityEvidence = exactLosslessMasterQualityEvidence(
      ledger.length,
      masterHashesMatch,
      qualityFailures,
    );
    await this.workspace.writeJson("evidence/cadence.json", cadenceEvidence);
    await this.workspace.writeJson("evidence/quality.json", qualityEvidence);
    const master = await recordingBundleArtifact(this.workspace.stagingPath, "master/video.mkv");
    const proxy = await recordingBundleArtifact(
      this.workspace.stagingPath,
      "proxy/video.mp4",
    ).catch(() => null);
    const audio = await Promise.all(
      [...this.audioRoles].sort().map(async (role) => ({
        ...(await recordingBundleArtifact(this.workspace.stagingPath, `audio/${role}.wav`)),
        role,
        codec: "pcm_s16le" as const,
      })),
    );
    const failureCodes = [...new Set([...cadenceEvidence.failure_codes, ...qualityFailures])];
    const completed =
      cadenceEvidence.verdict === "passed" &&
      qualityEvidence.verdict === "passed" &&
      proxy !== null;
    const manifest: RecordingBundleV2 = {
      schema_version: 2 as const,
      status: completed ? "completed" : "quality_failed",
      created_at: new Date().toISOString(),
      delivery_policy: this.options.deliveryPolicy,
      certified_tier: this.options.certifiedTier,
      capture_contract: this.options.captureContract,
      master: {
        ...master,
        relative_path: "master/video.mkv" as const,
        codec: "ffv1" as const,
        pixel_format: "bgra" as const,
        frame_count: ledger.length,
        exact_fps: { numerator: 60, denominator: 1 },
      },
      proxy: proxy
        ? {
            ...proxy,
            relative_path: "proxy/video.mp4" as const,
            codec: "h264" as const,
          }
        : null,
      audio,
      evidence: {
        cadence_path: "evidence/cadence.json" as const,
        quality_path: "evidence/quality.json" as const,
      },
      sidecars: { actions_path: actionsRelativePath },
      sequence_ledger_path: "evidence/sequence-ledger.jsonl",
      failure_codes: failureCodes,
    };
    const bundlePath = await this.workspace.commit(manifest);
    const finalMasterPath = path.join(bundlePath, manifest.master.relative_path);
    const finalProxyPath = manifest.proxy
      ? path.join(bundlePath, manifest.proxy.relative_path)
      : null;
    const durationMs = Math.round((ledger.length / 60) * 1_000);
    if (!completed || !finalProxyPath || !proxy) {
      return {
        version: 2,
        status: "quality_failed",
        delivery_policy: "strict",
        certified_tier: this.options.certifiedTier,
        bundle_path: bundlePath,
        output_path: null,
        diagnostic_bundle_path: bundlePath,
        duration_ms: durationMs,
        bytes: master.bytes + (proxy?.bytes ?? 0),
        master_path: finalMasterPath,
        proxy_path: finalProxyPath,
        cadence_evidence: cadenceEvidence,
        quality_evidence: qualityEvidence,
      };
    }
    return {
      version: 2,
      status: "completed",
      delivery_policy: "strict",
      certified_tier: this.options.certifiedTier,
      bundle_path: bundlePath,
      output_path: finalProxyPath,
      diagnostic_bundle_path: null,
      duration_ms: durationMs,
      bytes: master.bytes + proxy.bytes,
      master_path: finalMasterPath,
      proxy_path: finalProxyPath,
      cadence_evidence: cadenceEvidence,
      quality_evidence: qualityEvidence,
    };
  }

  async abort(): Promise<void> {
    this.encoder.abort();
    await this.workspace.discard();
  }
}

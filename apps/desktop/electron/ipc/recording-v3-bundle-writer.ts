import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  RecordingBundleV3,
  RecordingCadenceEvidenceV3,
  RecordingCaptureContractV3,
  RecordingCertificationProfileReferenceV3,
  RecordingCertifiedProfileV3,
  RecordingDiagnosticFrameLedgerEntryV3,
  RecordingFailureCodeV3,
  RecordingFrameLedgerEntryV3,
  RecordingQualityEvidenceV3,
  RecordingResultV3,
} from "@storycapture/shared-types/recording-v2";
import type { RecordingActions } from "./action-timeline";
import { RecordingBundleWorkspace, recordingBundleArtifact } from "./recording-bundle";
import { type RecordingV3EngineResult, verifyRecordingV3Artifact } from "./recording-v3-engine";

export interface RecordingV3BundleWriterOptions {
  exportsDir: string;
  name: string;
  captureContract: RecordingCaptureContractV3;
  manifestId: string;
  profile: RecordingCertifiedProfileV3;
  width: 1920;
  height: 1080;
  ffmpegBinary?: string;
  verifyArtifact?: typeof verifyRecordingV3Artifact;
}

export interface RecordingV3BundleFinalizeInput {
  engineResult: RecordingV3EngineResult;
  actions: RecordingActions | null;
}

function profileReference(
  profile: RecordingCertifiedProfileV3,
  manifestId: string,
): RecordingCertificationProfileReferenceV3 {
  return {
    manifest_id: manifestId,
    profile_id: profile.profile_id,
    evidence_artifact_sha256: profile.evidence_artifact_sha256,
  };
}

function diagnosticLedger(
  engineResult: RecordingV3EngineResult,
): RecordingDiagnosticFrameLedgerEntryV3[] {
  return engineResult.receipts.map((receipt) => ({
    version: 3,
    source_epoch: receipt.sourceEpoch,
    active_segment: receipt.activeSegment,
    source_frame_count: receipt.sourceFrameCount,
    source_timestamp_us: receipt.sourceTimestampUs,
    active_time_pts_us: receipt.activeTimePtsUs,
    delivery_ordinal: receipt.deliveryOrdinal + 1,
    native_lease_ordinal: receipt.nativeLeaseOrdinal + 1,
    native_commit_ordinal: receipt.nativeCommitOrdinal + 1,
    encoded_ordinal: receipt.encodedOrdinal + 1,
    decoded_ordinal: null,
    bgra_sha256: receipt.bgraSha256,
    failure_codes: ["artifact_verification_failed"],
  }));
}

function failedCadenceEvidence(
  engineResult: RecordingV3EngineResult,
  failureCode: RecordingFailureCodeV3,
): RecordingCadenceEvidenceV3 {
  const stats = engineResult.stats;
  return {
    version: 3,
    guarantee_boundary: "electron_offscreen_delivery",
    source_ordinal_kind: "electron_frame_count",
    requested_fps: { numerator: 60, denominator: 1 },
    source_fps: { numerator: 60, denominator: 1 },
    stream_time_base: { numerator: 1, denominator: 60 },
    active_duration_us: engineResult.activeDurationUs,
    expected_slots: engineResult.expectedSlots,
    source_presentations: stats.deliveryFrames,
    delivery_frames: stats.deliveryFrames,
    native_commits: stats.nativeCommits,
    encoded_frames: stats.encodedFrames,
    artifact_decoded_frames: 0,
    source_ordinal_gaps: stats.sourceOrdinalGaps,
    source_timestamp_regressions: stats.sourceTimestampRegressions,
    delivery_duplicates: 0,
    native_lease_overflows: stats.leaseOverflows,
    native_backpressure_events: stats.backpressureEvents,
    native_deadline_misses: stats.deadlineMisses,
    artifact_pts_gaps: 0,
    artifact_pts_duplicates: 0,
    full_decode_succeeded: false,
    verdict: "failed",
    failure_codes: [failureCode],
  };
}

function failedQualityEvidence(failureCode: RecordingFailureCodeV3): RecordingQualityEvidenceV3 {
  return {
    version: 3,
    measurement_scope: "runtime_integrity",
    reference_identity: null,
    evaluated_frames: 0,
    full_frame_luma_ssim: null,
    text_edge_roi_ssim: null,
    p01_edge_contrast_retention: null,
    edge_spread_increase_px: null,
    overlay_geometry_delta_px: null,
    color_channel_delta: null,
    lossless_master_hashes_match: null,
    certification_verdict: null,
    verdict: "failed",
    failure_codes: [failureCode],
  };
}

export class RecordingV3BundleWriter {
  readonly masterPath: string;
  readonly proxyPath: string;

  private constructor(
    readonly options: RecordingV3BundleWriterOptions,
    readonly workspace: RecordingBundleWorkspace,
  ) {
    this.masterPath = workspace.resolve("master/video.mkv");
    this.proxyPath = workspace.resolve("proxy/video.mp4");
  }

  static async create(options: RecordingV3BundleWriterOptions): Promise<RecordingV3BundleWriter> {
    const workspace = await RecordingBundleWorkspace.create(options.exportsDir, options.name);
    return new RecordingV3BundleWriter(options, workspace);
  }

  async finalize(input: RecordingV3BundleFinalizeInput): Promise<RecordingResultV3> {
    try {
      const verified = await (this.options.verifyArtifact ?? verifyRecordingV3Artifact)({
        engineResult: input.engineResult,
        masterPath: this.masterPath,
        proxyPath: this.proxyPath,
        width: this.options.width,
        height: this.options.height,
        ffmpegBinary: this.options.ffmpegBinary,
      });
      return await this.commit({
        engineResult: input.engineResult,
        actions: input.actions,
        ledger: verified.ledger,
        cadenceEvidence: verified.cadenceEvidence,
        qualityEvidence: verified.runtimeQualityEvidence,
        status: "completed",
        failureCodes: [],
        diagnosticError: null,
      });
    } catch (error) {
      await fs.rm(this.proxyPath, { force: true });
      return this.commit({
        engineResult: input.engineResult,
        actions: input.actions,
        ledger: diagnosticLedger(input.engineResult),
        cadenceEvidence: failedCadenceEvidence(input.engineResult, "artifact_verification_failed"),
        qualityEvidence: failedQualityEvidence("artifact_verification_failed"),
        status: "quality_failed",
        failureCodes: ["artifact_verification_failed"],
        diagnosticError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async abort(): Promise<void> {
    await this.workspace.discard();
  }

  private async commit(input: {
    engineResult: RecordingV3EngineResult;
    actions: RecordingActions | null;
    ledger: Array<RecordingFrameLedgerEntryV3 | RecordingDiagnosticFrameLedgerEntryV3>;
    cadenceEvidence: RecordingCadenceEvidenceV3;
    qualityEvidence: RecordingQualityEvidenceV3;
    status: RecordingBundleV3["status"];
    failureCodes: RecordingFailureCodeV3[];
    diagnosticError: string | null;
  }): Promise<RecordingResultV3> {
    if (input.ledger.length === 0) {
      throw new Error("Recording V3 cannot publish a bundle without frame evidence");
    }
    await this.writeJsonLines("evidence/frame-ledger.jsonl", input.ledger);
    await this.workspace.writeJson("evidence/cadence.json", input.cadenceEvidence);
    await this.workspace.writeJson("evidence/runtime-quality.json", input.qualityEvidence);
    const hasActions = Boolean(input.actions && input.actions.events.length > 0);
    if (hasActions && input.actions) {
      await Promise.all([
        this.workspace.writeJson("sidecars/actions.json", input.actions),
        this.workspace.writeJson("sidecars/cursor.json", input.actions),
      ]);
    }
    await this.workspace.writeJson("diagnostics/manifest.json", {
      version: 3,
      created_at: new Date().toISOString(),
      profile_id: this.options.profile.profile_id,
      native_stats: input.engineResult.stats,
      failure_codes: input.failureCodes,
      error: input.diagnosticError,
    });

    const master = await recordingBundleArtifact(this.workspace.stagingPath, "master/video.mkv");
    const proxy =
      input.status === "completed"
        ? await recordingBundleArtifact(this.workspace.stagingPath, "proxy/video.mp4")
        : null;
    const certificationProfile = profileReference(this.options.profile, this.options.manifestId);
    const manifest: RecordingBundleV3 = {
      schema_version: 3,
      status: input.status,
      created_at: new Date().toISOString(),
      delivery_policy: "strict",
      certification_profile: certificationProfile,
      capture_contract: this.options.captureContract,
      master: {
        ...master,
        relative_path: "master/video.mkv",
        codec: "ffv1",
        pixel_format: "bgra",
        frame_count: input.ledger.length,
        exact_fps: { numerator: 60, denominator: 1 },
      },
      proxy: proxy ? { ...proxy, relative_path: "proxy/video.mp4", codec: "h264" } : null,
      audio: [],
      evidence: {
        cadence_path: "evidence/cadence.json",
        runtime_quality_path: "evidence/runtime-quality.json",
        certification_quality_path: null,
      },
      sidecars: {
        actions_path: hasActions ? "sidecars/actions.json" : null,
        cursor_path: hasActions ? "sidecars/cursor.json" : null,
      },
      frame_ledger_path: "evidence/frame-ledger.jsonl",
      diagnostics_manifest_path: "diagnostics/manifest.json",
      failure_codes: input.failureCodes,
    };
    const bundlePath = await this.workspace.commit(manifest);
    const finalMasterPath = path.join(bundlePath, manifest.master.relative_path);
    const finalProxyPath = manifest.proxy
      ? path.join(bundlePath, manifest.proxy.relative_path)
      : null;
    const durationMs = Math.round(input.engineResult.activeDurationUs / 1_000);
    const bytes = master.bytes + (proxy?.bytes ?? 0);
    if (input.status === "quality_failed" || !finalProxyPath) {
      return {
        version: 3,
        status: "quality_failed",
        delivery_policy: "strict",
        guarantee_boundary: "electron_offscreen_delivery",
        certification_profile: certificationProfile,
        bundle_path: bundlePath,
        output_path: null,
        diagnostic_bundle_path: bundlePath,
        duration_ms: durationMs,
        bytes,
        master_path: finalMasterPath,
        proxy_path: null,
        cadence_evidence: input.cadenceEvidence,
        quality_evidence: input.qualityEvidence,
      };
    }
    return {
      version: 3,
      status: "completed",
      delivery_policy: "strict",
      guarantee_boundary: "electron_offscreen_delivery",
      certification_profile: certificationProfile,
      bundle_path: bundlePath,
      output_path: finalProxyPath,
      diagnostic_bundle_path: null,
      duration_ms: durationMs,
      bytes,
      master_path: finalMasterPath,
      proxy_path: finalProxyPath,
      cadence_evidence: input.cadenceEvidence,
      quality_evidence: input.qualityEvidence,
    };
  }

  private async writeJsonLines(
    relativePath: string,
    rows: ReadonlyArray<RecordingFrameLedgerEntryV3 | RecordingDiagnosticFrameLedgerEntryV3>,
  ): Promise<void> {
    const destination = this.workspace.resolve(relativePath);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    const text = rows.map((row) => JSON.stringify(row)).join("\n");
    await fs.writeFile(temporary, `${text}\n`, "utf8");
    await fs.rename(temporary, destination);
  }
}

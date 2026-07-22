import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  RecordingPlatform,
  RecordingSourceRateProbeV2,
  RecordingStorageEstimateV2,
} from "@storycapture/shared-types/recording-v2";
import type {
  RecordingFailureCodeV3,
  RecordingPreflightV3Dto,
  RecordingPreflightV3Request,
  RecordingV3DevelopmentEnvironmentDto,
} from "@storycapture/shared-types/recording-v3";
import { RECORDING_V3_STRICT_DIMENSIONS } from "@storycapture/shared-types/recording-v3";
import { app, BrowserWindow } from "electron";
import { isPackagedRuntime } from "../runtime";
import { ffmpegExecutablePath } from "./export-binaries";
import { recordingStoragePreflight, sha256File } from "./recording-bundle";
import { disabledRecordingCertificationTierIds } from "./recording-certification-catalog";
import {
  evaluateRecordingV3Capability,
  type RecordingV3CapabilityFacts,
} from "./recording-v3-capability";
import { recordingV3TextureMetadataFailure } from "./recording-v3-browser-backend";
import {
  BUNDLED_RECORDING_CERTIFICATION_SIGNER_KEYS_V3,
  type RecordingCertificationRuntimeIdentityV3,
  resolveRecordingCertificationProfileV3,
} from "./recording-v3-certification-manifest";
import {
  loadRecordingV3NativeAddon,
  RECORDING_V3_NATIVE_PROTOCOL_VERSION,
  RecordingV3NativeBridge,
  RecordingV3NativeError,
  recordingV3NativeAddonPathForRuntime,
} from "./recording-v3-native-addon";
import { isRecordingV3DevelopmentEnabled } from "./recording-v3-development-gate";

const SOURCE_PROBE_FRAMES = 60;
const SOURCE_PROBE_TIMEOUT_MS = 8_000;

function commandText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function unavailableSourceRate(): RecordingSourceRateProbeV2 {
  return {
    measured_fps: null,
    source_presentations: 0,
    sequence_gaps: 0,
    stale_reuses: 0,
    probe_duration_ms: 0,
  };
}

function unavailableStorage(): RecordingStorageEstimateV2 {
  return {
    estimated_bytes_per_second: 0,
    required_bytes_for_ten_minutes: 0,
    available_bytes: 0,
    reserve_bytes: 0,
  };
}

function certificationRoot(): string {
  return isPackagedRuntime(app)
    ? path.join(process.resourcesPath, "recording-v3-certification")
    : path.join(app.getAppPath(), "recording-v3-certification");
}

async function ffmpegVersion(binary: string): Promise<string> {
  const output = await commandText(binary, ["-version"]);
  return output.split("\n", 1)[0]?.trim() ?? "";
}

interface RecordingV3SourceProbeResult {
  sourceRate: RecordingSourceRateProbeV2;
  failureCodes: RecordingFailureCodeV3[];
}

export function recordingV3SourceMetadataFailure(
  request: RecordingPreflightV3Request,
  textureInfo: {
    widgetType: string;
    codedSize: { width: number; height: number };
    pixelFormat: string;
  },
): RecordingFailureCodeV3 | null {
  return (
    recordingV3TextureMetadataFailure(textureInfo, {
      width: request.dimensions.physical_width,
      height: request.dimensions.physical_height,
    })?.code ?? null
  );
}

async function probeBrowserSourceV3(
  request: RecordingPreflightV3Request,
  url: string,
): Promise<RecordingV3SourceProbeResult> {
  if (!url || url === "about:blank") {
    return { sourceRate: unavailableSourceRate(), failureCodes: ["source_metadata_missing"] };
  }
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: request.dimensions.logical_width,
    height: request.dimensions.logical_height,
    webPreferences: {
      partition: `storycapture-recording-v3-probe-${randomUUID()}`,
      offscreen: {
        useSharedTexture: true,
        sharedTexturePixelFormat: "argb",
        deviceScaleFactor: request.dimensions.capture_dpr,
      },
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const samples: Array<{ frameCount: number; timestampUs: number }> = [];
  let accepting = false;
  let sequenceGaps = 0;
  let staleReuses = 0;
  let metadataFailure: RecordingFailureCodeV3 | null = null;
  let receivedTexture = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    window.webContents.setFrameRate(60);
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (timer) clearTimeout(timer);
        window.webContents.off("paint", onPaint);
        if (error) reject(error);
        else resolve();
      };
      const onPaint = (event: Electron.Event) => {
        const texture = (event as Electron.Event & { texture?: Electron.OffscreenSharedTexture })
          .texture;
        if (!texture) return;
        try {
          if (!accepting) return;
          receivedTexture = true;
          metadataFailure = recordingV3SourceMetadataFailure(request, texture.textureInfo);
          if (metadataFailure) {
            finish();
            return;
          }
          const frameCount = texture.textureInfo.metadata.frameCount;
          const timestampUs = texture.textureInfo.timestamp;
          if (!Number.isSafeInteger(frameCount) || !Number.isSafeInteger(timestampUs)) return;
          const previous = samples.at(-1);
          if (previous) {
            if (Number(frameCount) === previous.frameCount) staleReuses += 1;
            else if (Number(frameCount) !== previous.frameCount + 1) sequenceGaps += 1;
          }
          samples.push({ frameCount: Number(frameCount), timestampUs });
          if (samples.length >= SOURCE_PROBE_FRAMES) finish();
          else window.webContents.invalidate();
        } finally {
          texture.release();
        }
      };
      window.webContents.on("paint", onPaint);
      timer = setTimeout(
        () => finish(new Error("Recording V3 browser source-rate probe timed out")),
        SOURCE_PROBE_TIMEOUT_MS,
      );
      timer.unref?.();
      void window
        .loadURL(url)
        .then(() => {
          accepting = true;
          window.webContents.invalidate();
        })
        .catch((error) => finish(error));
    });
  } catch {
    return {
      sourceRate: {
        ...unavailableSourceRate(),
        source_presentations: samples.length,
        sequence_gaps: sequenceGaps,
        stale_reuses: staleReuses,
      },
      failureCodes: [metadataFailure ?? (receivedTexture ? "source_metadata_invalid" : "source_metadata_missing")],
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
  const firstTimestamp = samples[0]?.timestampUs ?? 0;
  const lastTimestamp = samples.at(-1)?.timestampUs ?? firstTimestamp;
  const elapsedUs = lastTimestamp - firstTimestamp;
  const measuredFps = elapsedUs > 0 ? ((samples.length - 1) * 1_000_000) / elapsedUs : 0;
  const exact60 = Math.abs(measuredFps - 60) / 60 <= 0.02;
  return {
    sourceRate: {
      measured_fps:
        !metadataFailure && exact60 && sequenceGaps === 0 && staleReuses === 0
          ? { numerator: 60, denominator: 1 }
          : null,
      source_presentations: samples.length,
      sequence_gaps: sequenceGaps,
      stale_reuses: staleReuses,
      probe_duration_ms: elapsedUs / 1_000,
    },
    failureCodes: metadataFailure ? [metadataFailure] : [],
  };
}

export async function probeBrowserSourceRateV3(
  request: RecordingPreflightV3Request,
  url: string,
): Promise<RecordingSourceRateProbeV2> {
  return (await probeBrowserSourceV3(request, url)).sourceRate;
}

interface CommonRecordingV3RuntimeFacts
  extends Omit<
    RecordingV3CapabilityFacts,
    "manifestId" | "matchedProfile" | "sourceRate" | "failureCodes"
  > {
  addonPath: string;
  ffmpegPath: string;
  failureCodes: RecordingFailureCodeV3[];
}

async function probeCommonRecordingV3Runtime(input: {
  projectFolder: string;
  certificationRequired: boolean;
  outputWidth: number;
  outputHeight: number;
}): Promise<CommonRecordingV3RuntimeFacts> {
  const failureCodes: RecordingFailureCodeV3[] = [];
  const fail = (code: RecordingFailureCodeV3) => {
    if (!failureCodes.includes(code)) failureCodes.push(code);
  };
  const platform: RecordingPlatform = process.platform === "darwin" ? "darwin" : "win32";
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail(input.certificationRequired ? "profile_mismatch" : "contract_mismatch");
  }

  const addonPath = recordingV3NativeAddonPathForRuntime({
    app,
    resourcesPath: process.resourcesPath,
    desktopRoot: app.getAppPath(),
  });
  const ffmpegPath = ffmpegExecutablePath();

  let nativeProbePassed = false;
  let addonProtocolVersion = RECORDING_V3_NATIVE_PROTOCOL_VERSION;
  try {
    const bridge = new RecordingV3NativeBridge(loadRecordingV3NativeAddon(addonPath));
    const probe = bridge.probe();
    addonProtocolVersion = probe.protocolVersion;
    nativeProbePassed = probe.ioSurface && probe.nativeFfv1;
  } catch (error) {
    fail(error instanceof RecordingV3NativeError ? error.code : "addon_load_failed");
  }

  let storage = unavailableStorage();
  let storageEligible = false;
  if (input.projectFolder) {
    try {
      const exportsDir = path.join(input.projectFolder, "exports");
      const probeDir = await fs
        .stat(exportsDir)
        .then(() => exportsDir)
        .catch(() => input.projectFolder);
      const result = await recordingStoragePreflight(probeDir, {
        width: input.outputWidth,
        height: input.outputHeight,
        fps: 60,
      });
      storage = {
        estimated_bytes_per_second: result.estimated_bytes_per_second,
        required_bytes_for_ten_minutes: result.required_bytes_for_ten_minutes,
        available_bytes: result.available_bytes,
        reserve_bytes: result.reserve_bytes,
      };
      storageEligible = result.eligible;
    } catch {
      fail("storage_preflight_failed");
    }
  } else {
    fail("storage_preflight_failed");
  }

  let hardwareModel = "unknown";
  let hardwareChip = "unknown";
  let osBuild = "unknown";
  try {
    const [model, chip, build] = await Promise.all([
      commandText("/usr/sbin/sysctl", ["-n", "hw.model"]),
      commandText("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
      commandText("/usr/bin/sw_vers", ["-buildVersion"]),
    ]);
    hardwareModel = model;
    hardwareChip = chip;
    osBuild = build;
  } catch {
    if (input.certificationRequired) fail("profile_mismatch");
  }

  try {
    await ffmpegVersion(ffmpegPath);
  } catch {
    fail(input.certificationRequired ? "profile_mismatch" : "contract_mismatch");
  }

  return {
    platform,
    arch: process.arch,
    hardwareModel,
    hardwareChip,
    osBuild,
    addonProtocolVersion,
    storage,
    storageEligible,
    nativeProbePassed,
    permissionsGranted: true,
    addonPath,
    ffmpegPath,
    failureCodes,
  };
}

async function resolveStrictRecordingV3Certification(
  common: CommonRecordingV3RuntimeFacts,
  nowMs?: number,
): Promise<{
  manifestId: string | null;
  matchedProfile: RecordingV3CapabilityFacts["matchedProfile"];
  failureCodes: RecordingFailureCodeV3[];
}> {
  const root = certificationRoot();
  const manifestPath = path.join(root, "manifest.json");
  const evidencePath = path.join(root, "evidence.json");
  let manifestValue: unknown = null;
  try {
    manifestValue = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  } catch {
    return { manifestId: null, matchedProfile: null, failureCodes: ["manifest_missing"] };
  }

  let runtimeIdentity: RecordingCertificationRuntimeIdentityV3 | null = null;
  try {
    const [addonSha256, ffmpegSha256, evidenceSha256, version] = await Promise.all([
      sha256File(common.addonPath),
      sha256File(common.ffmpegPath),
      sha256File(evidencePath),
      ffmpegVersion(common.ffmpegPath),
    ]);
    runtimeIdentity = {
      target_class: "browser",
      platform: common.platform,
      arch: common.arch,
      hardware_model: common.hardwareModel,
      hardware_chip: common.hardwareChip,
      os_build: common.osBuild,
      backend_id: "electron_offscreen_shared_texture_v3",
      backend_version: "3.0.0",
      addon_protocol_version: common.addonProtocolVersion,
      addon_sha256: addonSha256,
      electron_version: process.versions.electron ?? "unknown",
      chromium_version: process.versions.chrome ?? "unknown",
      ffmpeg_version: version,
      ffmpeg_sha256: ffmpegSha256,
      output_width: RECORDING_V3_STRICT_DIMENSIONS.requested_output_width,
      output_height: RECORDING_V3_STRICT_DIMENSIONS.requested_output_height,
      exact_fps: { numerator: 60, denominator: 1 },
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
      evidence_artifact_sha256: evidenceSha256,
    };
  } catch {
    return { manifestId: null, matchedProfile: null, failureCodes: ["profile_mismatch"] };
  }

  const resolution =
    runtimeIdentity && manifestValue
      ? resolveRecordingCertificationProfileV3({
          manifest: manifestValue,
          runtime: runtimeIdentity,
          signerKeys: BUNDLED_RECORDING_CERTIFICATION_SIGNER_KEYS_V3,
          disabledKillSwitchIds: disabledRecordingCertificationTierIds(),
          nowMs,
        })
      : { manifest: null, profile: null, failure_codes: [] as RecordingFailureCodeV3[] };
  return {
    manifestId: resolution.manifest?.payload.manifest_id ?? null,
    matchedProfile: resolution.profile,
    failureCodes: resolution.failure_codes,
  };
}

export function evaluateRecordingV3DevelopmentEnvironment(input: {
  developmentEnabled: boolean;
  nativeProbePassed: boolean;
  storageEligible: boolean;
  failureCodes: RecordingFailureCodeV3[];
}): RecordingV3DevelopmentEnvironmentDto {
  return {
    version: 3,
    development_enabled: input.developmentEnabled,
    development_available:
      input.developmentEnabled &&
      input.nativeProbePassed &&
      input.storageEligible &&
      input.failureCodes.length === 0,
    native_probe_passed: input.nativeProbePassed,
    failure_codes: input.failureCodes,
  };
}

export async function probeRecordingV3DevelopmentEnvironment(): Promise<RecordingV3DevelopmentEnvironmentDto> {
  const developmentEnabled = isRecordingV3DevelopmentEnabled(app);
  if (!developmentEnabled) {
    return evaluateRecordingV3DevelopmentEnvironment({
      developmentEnabled: false,
      nativeProbePassed: false,
      storageEligible: false,
      failureCodes: [],
    });
  }
  const common = await probeCommonRecordingV3Runtime({
    projectFolder: app.getPath("userData"),
    certificationRequired: false,
    outputWidth: RECORDING_V3_STRICT_DIMENSIONS.requested_output_width,
    outputHeight: RECORDING_V3_STRICT_DIMENSIONS.requested_output_height,
  });
  return evaluateRecordingV3DevelopmentEnvironment({
    developmentEnabled: true,
    nativeProbePassed: common.nativeProbePassed,
    storageEligible: common.storageEligible,
    failureCodes: common.failureCodes,
  });
}

export async function probeRecordingV3RuntimeCapability(input: {
  request: RecordingPreflightV3Request;
  projectFolder: string;
  url: string;
  nowMs?: number;
}): Promise<RecordingPreflightV3Dto> {
  if (
    input.request.intent === "development" &&
    !isRecordingV3DevelopmentEnabled(app)
  ) {
    return evaluateRecordingV3Capability(input.request, {
      platform: process.platform === "darwin" ? "darwin" : "win32",
      arch: process.arch,
      hardwareModel: "unknown",
      hardwareChip: "unknown",
      osBuild: "unknown",
      addonProtocolVersion: RECORDING_V3_NATIVE_PROTOCOL_VERSION,
      manifestId: null,
      matchedProfile: null,
      sourceRate: unavailableSourceRate(),
      storage: unavailableStorage(),
      storageEligible: false,
      nativeProbePassed: false,
      permissionsGranted: true,
      failureCodes: ["contract_mismatch"],
    });
  }
  const certificationRequired = input.request.intent === "strict";
  const common = await probeCommonRecordingV3Runtime({
    projectFolder: input.projectFolder,
    certificationRequired,
    outputWidth: input.request.dimensions.requested_output_width,
    outputHeight: input.request.dimensions.requested_output_height,
  });
  const certification = certificationRequired
    ? await resolveStrictRecordingV3Certification(common, input.nowMs)
    : { manifestId: null, matchedProfile: null, failureCodes: [] as RecordingFailureCodeV3[] };

  const sourceProbe =
    input.request.intent === "development" || certification.matchedProfile
      ? await probeBrowserSourceV3(input.request, input.url)
      : { sourceRate: unavailableSourceRate(), failureCodes: [] as RecordingFailureCodeV3[] };
  return evaluateRecordingV3Capability(input.request, {
    platform: common.platform,
    arch: common.arch,
    hardwareModel: common.hardwareModel,
    hardwareChip: common.hardwareChip,
    osBuild: common.osBuild,
    addonProtocolVersion: common.addonProtocolVersion,
    manifestId: certification.manifestId,
    matchedProfile: certification.matchedProfile,
    sourceRate: sourceProbe.sourceRate,
    storage: common.storage,
    storageEligible: common.storageEligible,
    nativeProbePassed: common.nativeProbePassed,
    permissionsGranted: common.permissionsGranted,
    failureCodes: [
      ...common.failureCodes,
      ...certification.failureCodes,
      ...sourceProbe.failureCodes,
    ],
  });
}

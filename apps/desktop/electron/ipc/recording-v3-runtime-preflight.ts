import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  RecordingFailureCodeV3,
  RecordingPlatform,
  RecordingPreflightV3Dto,
  RecordingPreflightV3Request,
  RecordingSourceRateProbeV2,
  RecordingStorageEstimateV2,
} from "@storycapture/shared-types/recording-v2";
import { app, BrowserWindow } from "electron";
import { ffmpegExecutablePath } from "./export-binaries";
import { recordingStoragePreflight, sha256File } from "./recording-bundle";
import { disabledRecordingCertificationTierIds } from "./recording-certification-catalog";
import { evaluateRecordingV3Capability } from "./recording-v3-capability";
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
  recordingV3NativeAddonPath,
} from "./recording-v3-native-addon";

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
  return app.isPackaged
    ? path.join(process.resourcesPath, "recording-v3-certification")
    : path.join(app.getAppPath(), "recording-v3-certification");
}

async function ffmpegVersion(binary: string): Promise<string> {
  const output = await commandText(binary, ["-version"]);
  return output.split("\n", 1)[0]?.trim() ?? "";
}

export async function probeBrowserSourceRateV3(
  request: RecordingPreflightV3Request,
  url: string,
): Promise<RecordingSourceRateProbeV2> {
  if (!url || url === "about:blank") return unavailableSourceRate();
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
          if (!accepting || texture.textureInfo.widgetType !== "frame") return;
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
      ...unavailableSourceRate(),
      source_presentations: samples.length,
      sequence_gaps: sequenceGaps,
      stale_reuses: staleReuses,
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
    measured_fps:
      exact60 && sequenceGaps === 0 && staleReuses === 0 ? { numerator: 60, denominator: 1 } : null,
    source_presentations: samples.length,
    sequence_gaps: sequenceGaps,
    stale_reuses: staleReuses,
    probe_duration_ms: elapsedUs / 1_000,
  };
}

export async function probeRecordingV3RuntimeCapability(input: {
  request: RecordingPreflightV3Request;
  projectFolder: string;
  url: string;
  nowMs?: number;
}): Promise<RecordingPreflightV3Dto> {
  const failureCodes: RecordingFailureCodeV3[] = [];
  const fail = (code: RecordingFailureCodeV3) => {
    if (!failureCodes.includes(code)) failureCodes.push(code);
  };
  const platform: RecordingPlatform = process.platform === "darwin" ? "darwin" : "win32";
  if (process.platform !== "darwin" || process.arch !== "arm64") fail("profile_mismatch");

  const addonPath = recordingV3NativeAddonPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopRoot: app.getAppPath(),
  });
  const ffmpegPath = ffmpegExecutablePath();
  const root = certificationRoot();
  const manifestPath = path.join(root, "manifest.json");
  const evidencePath = path.join(root, "evidence.json");

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
        width: 1920,
        height: 1080,
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

  let manifestValue: unknown = null;
  try {
    manifestValue = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  } catch {
    fail("manifest_missing");
  }

  let hardwareModel = "unknown";
  let hardwareChip = "unknown";
  let osBuild = "unknown";
  let runtimeIdentity: RecordingCertificationRuntimeIdentityV3 | null = null;
  try {
    const [model, chip, build, addonSha256, ffmpegSha256, evidenceSha256, version] =
      await Promise.all([
        commandText("/usr/sbin/sysctl", ["-n", "hw.model"]),
        commandText("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
        commandText("/usr/bin/sw_vers", ["-buildVersion"]),
        sha256File(addonPath),
        sha256File(ffmpegPath),
        sha256File(evidencePath),
        ffmpegVersion(ffmpegPath),
      ]);
    hardwareModel = model;
    hardwareChip = chip;
    osBuild = build;
    runtimeIdentity = {
      target_class: "browser",
      platform,
      arch: process.arch,
      hardware_model: model,
      hardware_chip: chip,
      os_build: build,
      backend_id: "electron_offscreen_shared_texture_v3",
      backend_version: "3.0.0",
      addon_protocol_version: addonProtocolVersion,
      addon_sha256: addonSha256,
      electron_version: process.versions.electron ?? "unknown",
      chromium_version: process.versions.chrome ?? "unknown",
      ffmpeg_version: version,
      ffmpeg_sha256: ffmpegSha256,
      output_width: 1920,
      output_height: 1080,
      exact_fps: { numerator: 60, denominator: 1 },
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
      evidence_artifact_sha256: evidenceSha256,
    };
  } catch {
    fail("profile_mismatch");
  }

  const resolution =
    runtimeIdentity && manifestValue
      ? resolveRecordingCertificationProfileV3({
          manifest: manifestValue,
          runtime: runtimeIdentity,
          signerKeys: BUNDLED_RECORDING_CERTIFICATION_SIGNER_KEYS_V3,
          disabledKillSwitchIds: disabledRecordingCertificationTierIds(),
          nowMs: input.nowMs,
        })
      : { manifest: null, profile: null, failure_codes: [] as RecordingFailureCodeV3[] };
  for (const code of resolution.failure_codes) fail(code);

  const sourceRate = resolution.profile
    ? await probeBrowserSourceRateV3(input.request, input.url)
    : unavailableSourceRate();
  return evaluateRecordingV3Capability(input.request, {
    platform,
    arch: process.arch,
    hardwareModel,
    hardwareChip,
    osBuild,
    addonProtocolVersion,
    manifestId: resolution.manifest?.payload.manifest_id ?? null,
    matchedProfile: resolution.profile,
    sourceRate,
    storage,
    storageEligible,
    nativeProbePassed,
    permissionsGranted: true,
    failureCodes,
  });
}

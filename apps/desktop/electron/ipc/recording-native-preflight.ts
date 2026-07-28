import fs from "node:fs/promises";
import path from "node:path";
import type {
  RecordingNativePreflightV3,
  RecordingV3FailureCode,
} from "@storycapture/shared-types/recording-v3";
import { app, systemPreferences } from "electron";

import {
  type MacNativeMasterCapability,
  MacOSNativeMasterBackend,
  resolveMacScreenCaptureHelperPath,
} from "./macos-screen-capture-backend";
import {
  resolveWindowsCaptureHelperPath,
  WindowsNativeMp4CaptureSession,
} from "./windows-capture-backend";
import type { WindowsNativeCaptureCapabilities } from "./windows-capture-protocol";

const TEN_MINUTE_H264_BYTES = Math.ceil((25_000_000 / 8) * 600);
const STORAGE_RESERVE_BYTES = 1024 ** 3;

export interface RecordingNativePreflightOptions {
  exportsDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  env?: NodeJS.ProcessEnv;
  statfs?: typeof fs.statfs;
  accessStatus?: () => "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  helperExists?: (helperPath: string) => Promise<boolean>;
  probeMac?: (helperPath: string) => Promise<MacNativeMasterCapability>;
  probeWindows?: (helperPath: string) => Promise<WindowsNativeCaptureCapabilities>;
}

export interface RecordingNativePreflightResult {
  preflight: RecordingNativePreflightV3;
  helperPath: string;
}

function pushFailure(failures: RecordingV3FailureCode[], failure: RecordingV3FailureCode): void {
  if (!failures.includes(failure)) failures.push(failure);
}

function permissionStatus(
  platform: NodeJS.Platform,
  override?: RecordingNativePreflightOptions["accessStatus"],
): RecordingNativePreflightV3["permission"] {
  if (platform === "win32") return "granted";
  const status = override?.() ?? systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted" || status === "denied") return status;
  if (status === "not-determined") return "not_determined";
  return "denied";
}

function helperPathFor(
  platform: NodeJS.Platform,
  arch: string,
  input: Pick<RecordingNativePreflightOptions, "isPackaged" | "resourcesPath" | "appPath">,
): string {
  const isPackaged = input.isPackaged ?? app.isPackaged;
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  const appPath = input.appPath ?? app.getAppPath();
  if (platform === "darwin") {
    return resolveMacScreenCaptureHelperPath({ isPackaged, resourcesPath, appPath });
  }
  if (platform === "win32") {
    return resolveWindowsCaptureHelperPath({ isPackaged, resourcesPath, appPath, arch });
  }
  return path.join(appPath, "unsupported-native-recording-helper");
}

async function defaultMacProbe(helperPath: string): Promise<MacNativeMasterCapability> {
  const backend = new MacOSNativeMasterBackend({
    helperPath,
    target: { kind: "window", windowID: 1, mediaSourceID: "window:1:0" },
  });
  try {
    return await backend.probeCapabilities();
  } finally {
    backend.close();
  }
}

async function defaultWindowsProbe(helperPath: string): Promise<WindowsNativeCaptureCapabilities> {
  const session = new WindowsNativeMp4CaptureSession({ helperPath });
  try {
    return await session.capabilities();
  } finally {
    await session.shutdown();
  }
}

export async function recordingNativeGlobalPreflight(
  options: RecordingNativePreflightOptions,
): Promise<RecordingNativePreflightResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const helperPath = helperPathFor(platform, arch, options);
  const failures: RecordingV3FailureCode[] = [];
  const supported = platform === "darwin" || platform === "win32";
  if (!supported) pushFailure(failures, "backend_unavailable");
  const helperAvailable = supported
    ? await (
        options.helperExists ??
        (async (candidate) => {
          const stat = await fs.stat(candidate).catch(() => null);
          return Boolean(stat?.isFile() && stat.size > 0);
        })
      )(helperPath)
    : false;
  if (!helperAvailable) pushFailure(failures, "backend_unavailable");

  const permission = permissionStatus(platform, options.accessStatus);
  if (permission !== "granted") pushFailure(failures, "permission_denied");
  const policyAllowed = options.env?.STORYCAPTURE_DISABLE_STRICT_NATIVE_RECORDING !== "1";
  if (!policyAllowed) pushFailure(failures, "preflight_failed");

  await fs.mkdir(options.exportsDir, { recursive: true });
  const storage = await (options.statfs ?? fs.statfs)(options.exportsDir).catch(() => null);
  const availableBytes = storage ? Number(storage.bavail) * Number(storage.bsize) : 0;
  const storageRequiredBytes = TEN_MINUTE_H264_BYTES + STORAGE_RESERVE_BYTES;
  if (!storage) pushFailure(failures, "storage_estimate_failed");
  else if (availableBytes < storageRequiredBytes) {
    pushFailure(failures, "storage_reserve_exhausted");
  }

  let protocolCompatible = false;
  let encoderAvailable = false;
  let encoderId: string | null = null;
  let hardwareAccelerated = false;
  if (helperAvailable && permission === "granted" && policyAllowed) {
    try {
      if (platform === "darwin") {
        const capability = await (options.probeMac ?? defaultMacProbe)(helperPath);
        protocolCompatible = capability.backend_version === "3.0.0";
        encoderAvailable = capability.supports_hardware_h264;
        encoderId = capability.encoder.id;
        hardwareAccelerated = capability.encoder.hardware_accelerated;
      } else if (platform === "win32") {
        const capability = await (options.probeWindows ?? defaultWindowsProbe)(helperPath);
        protocolCompatible = true;
        encoderAvailable = capability.codec === "h264";
        encoderId = capability.encoder_id;
        hardwareAccelerated = capability.hardware_accelerated;
      }
    } catch {
      pushFailure(failures, "backend_capability_mismatch");
    }
  }
  if (helperAvailable && !protocolCompatible) {
    pushFailure(failures, "backend_capability_mismatch");
  }
  if (helperAvailable && (!encoderAvailable || !hardwareAccelerated)) {
    pushFailure(failures, "encoder_unavailable");
  }
  return {
    helperPath,
    preflight: {
      version: 3,
      platform: platform === "win32" ? "win32" : "darwin",
      helper_available: helperAvailable,
      protocol_compatible: protocolCompatible,
      permission,
      encoder_available: encoderAvailable,
      encoder_id: encoderId,
      hardware_accelerated: hardwareAccelerated,
      storage_available_bytes: availableBytes,
      storage_required_bytes: storageRequiredBytes,
      policy_allowed: policyAllowed,
      strict_eligible: failures.length === 0,
      failure_codes: failures,
    },
  };
}

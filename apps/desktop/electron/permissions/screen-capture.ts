import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PermissionState, ScreenCapturePermissionReportDto } from "@storycapture/shared-types";

import identity from "../identity.json";

const execFileAsync = promisify(execFile);

export const DEV_BUNDLE_ID = identity.devBundleId;
export const PROD_BUNDLE_ID = identity.prodBundleId;

export type ScreenCapturePermissionState = PermissionState;
export type ScreenCapturePermissionReport = ScreenCapturePermissionReportDto;

export interface ScreenCapturePermissionDependencies {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  fallbackAppName: string;
  debugBypassAllowed: boolean;
  getMediaAccessStatus: () => string;
  enumerateScreenSources: () => Promise<number>;
}

interface AppIdentity {
  appName: string;
  bundleId: string | null;
}

interface PermissionReportOptions {
  probe: boolean;
  timeoutMs?: number;
}

const identityCache = new Map<string, Promise<AppIdentity>>();

export function mapScreenCaptureStatus(rawStatus: string): ScreenCapturePermissionState {
  switch (rawStatus) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    case "not-determined":
    case "unknown":
    default:
      return "undetermined";
  }
}

export function devIdentityStatus({
  platform,
  isPackaged,
  bundleId,
}: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  bundleId: string | null;
}): boolean | null {
  if (platform !== "darwin") return null;
  return bundleId === (isPackaged ? PROD_BUNDLE_ID : DEV_BUNDLE_ID);
}

export function macAppPathFromExecutable(executablePath: string): string | null {
  const macOSDir = path.dirname(executablePath);
  const contentsDir = path.dirname(macOSDir);
  const appPath = path.dirname(contentsDir);
  if (path.basename(macOSDir) !== "MacOS") return null;
  if (path.basename(contentsDir) !== "Contents") return null;
  if (!appPath.endsWith(".app")) return null;
  return appPath;
}

async function readPlistJson(plistPath: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      plistPath,
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function readXmlPlistValue(xml: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]*)</string>`));
  return match?.[1] ?? null;
}

export async function readMacAppIdentity(
  executablePath: string,
  fallbackAppName: string,
): Promise<AppIdentity> {
  const cacheKey = `${executablePath}\0${fallbackAppName}`;
  const cached = identityCache.get(cacheKey);
  if (cached) return cached;
  const identityPromise = readMacAppIdentityUncached(executablePath, fallbackAppName);
  identityCache.set(cacheKey, identityPromise);
  return identityPromise;
}

async function readMacAppIdentityUncached(
  executablePath: string,
  fallbackAppName: string,
): Promise<AppIdentity> {
  const appPath = macAppPathFromExecutable(executablePath);
  if (!appPath) return { appName: fallbackAppName, bundleId: null };

  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const plist = await readPlistJson(plistPath);
  if (plist) {
    const appName =
      (typeof plist.CFBundleDisplayName === "string" && plist.CFBundleDisplayName) ||
      (typeof plist.CFBundleName === "string" && plist.CFBundleName) ||
      fallbackAppName;
    return {
      appName,
      bundleId: typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : null,
    };
  }

  try {
    const xml = await fs.readFile(plistPath, "utf8");
    return {
      appName:
        readXmlPlistValue(xml, "CFBundleDisplayName") ??
        readXmlPlistValue(xml, "CFBundleName") ??
        fallbackAppName,
      bundleId: readXmlPlistValue(xml, "CFBundleIdentifier"),
    };
  } catch {
    return { appName: fallbackAppName, bundleId: null };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("screen source probe timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function appendReason(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

export async function screenCapturePermissionReport(
  deps: ScreenCapturePermissionDependencies,
  { probe, timeoutMs = 2500 }: PermissionReportOptions,
): Promise<ScreenCapturePermissionReport> {
  const identityPromise =
    deps.platform === "darwin"
      ? readMacAppIdentity(deps.executablePath, deps.fallbackAppName)
      : Promise.resolve({ appName: deps.fallbackAppName, bundleId: null });
  const probePromise =
    probe && deps.platform === "darwin"
      ? withTimeout(deps.enumerateScreenSources(), timeoutMs)
      : null;
  let rawStatus = deps.platform === "darwin" ? "unknown" : "granted";
  let reason: string | undefined;

  if (deps.platform === "darwin") {
    try {
      rawStatus = deps.getMediaAccessStatus();
    } catch (error) {
      reason = appendReason(reason, `permission status unavailable: ${String(error)}`);
    }
  }

  const identity = await identityPromise;
  const verifiedIdentityOk = devIdentityStatus({
    platform: deps.platform,
    isPackaged: deps.isPackaged,
    bundleId: identity.bundleId,
  });

  const baseReport: ScreenCapturePermissionReport = {
    state: mapScreenCaptureStatus(rawStatus),
    rawStatus,
    platform: deps.platform,
    appName: identity.appName,
    bundleId: identity.bundleId,
    executablePath: deps.executablePath,
    isPackaged: deps.isPackaged,
    devIdentityOk: verifiedIdentityOk,
    canEnumerateSources: deps.platform !== "darwin",
    sourceCount: 0,
    debugBypassAllowed: deps.debugBypassAllowed && !deps.isPackaged && verifiedIdentityOk === true,
    ...(reason ? { reason } : {}),
  };

  if (!probe || deps.platform !== "darwin") {
    return baseReport;
  }

  try {
    const sourceCount = await probePromise;
    return {
      ...baseReport,
      state: sourceCount > 0 ? "granted" : baseReport.state,
      canEnumerateSources: true,
      sourceCount,
    };
  } catch (error) {
    return {
      ...baseReport,
      state: baseReport.state === "denied" ? "denied" : "undetermined",
      canEnumerateSources: false,
      sourceCount: 0,
      reason: appendReason(baseReport.reason, `screen source probe failed: ${String(error)}`),
    };
  }
}

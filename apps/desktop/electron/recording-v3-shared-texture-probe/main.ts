import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow } from "electron";
import { ffmpegExecutablePath } from "../ipc/export-binaries";
import {
  loadNativeSharedTextureProbe,
  type NativeSharedTextureProbeReceipt,
  type NativeSharedTextureProbeSession,
  type NativeSharedTextureProbeStats,
  nativeSharedTextureProbeAddonPath,
} from "./native-addon-loader";
import {
  evaluateSharedTextureProbeGate,
  SHARED_TEXTURE_PROBE_FRAME_COUNT,
  SHARED_TEXTURE_PROBE_HEIGHT,
  SHARED_TEXTURE_PROBE_MEMORY_GROWTH_LIMIT_BYTES,
  SHARED_TEXTURE_PROBE_P95_LIMIT_MS,
  SHARED_TEXTURE_PROBE_P99_LIMIT_MS,
  SHARED_TEXTURE_PROBE_WIDTH,
} from "./report";

const REPORT_VERSION = 1;
const reportPath = process.env.STORYCAPTURE_SHARED_TEXTURE_PROBE_REPORT;
app.on("window-all-closed", () => {
  // The probe owns process shutdown after the native session and report are finalized.
});
process.stderr.write(
  `[shared-texture-probe] startup packaged=${app.isPackaged} report=${reportPath ?? "missing"}\n`,
);

function commandOutput(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verifyCodeSignature(targetPath: string): {
  verified: boolean;
  kind: "adhoc" | "developer_id" | "other" | "unverified";
  detail: string;
} {
  try {
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", targetPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const display = spawnSync("/usr/bin/codesign", ["-dvv", targetPath], { encoding: "utf8" });
    const detail = `${display.stdout ?? ""}\n${display.stderr ?? ""}`.trim();
    const kind = detail.includes("Signature=adhoc")
      ? "adhoc"
      : detail.includes("Authority=Developer ID Application")
        ? "developer_id"
        : "other";
    return { verified: true, kind, detail };
  } catch (error) {
    return {
      verified: false,
      kind: "unverified",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function packagedAppPath(): string {
  return path.resolve(path.dirname(process.execPath), "../..");
}

function blankStats(failureReason: string): NativeSharedTextureProbeStats {
  return {
    handlesImported: 0,
    handlesReleased: 0,
    activeLeases: 0,
    peakActiveLeases: 0,
    nativeAcceptedFrames: 0,
    ffmpegEnqueuedFrames: 0,
    queueOverflows: 0,
    maxReadyQueueDepth: 0,
    lastFrameCount: 0,
    lastTimestampUs: 0,
    serviceTimeP95Ms: 0,
    serviceTimeP99Ms: 0,
    serviceTimeMaxMs: 0,
    boundedPoolBytes: 0,
    baselineResidentBytes: 0,
    peakResidentBytes: 0,
    finalResidentBytes: 0,
    ffmpegLaunched: false,
    ffmpegExitCode: -1,
    failed: true,
    failureReason,
  };
}

async function writeReport(report: unknown): Promise<void> {
  if (!reportPath) throw new Error("STORYCAPTURE_SHARED_TEXTURE_PROBE_REPORT is required");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function runProbe(): Promise<{ report: unknown; passed: boolean }> {
  const receipts: NativeSharedTextureProbeReceipt[] = [];
  const failures: string[] = [];
  let session: NativeSharedTextureProbeSession | undefined;
  let stats = blankStats("probe did not start");
  let codedSizeMatches = true;
  let jsFrameBytes = 0;
  let addonLoadedFromPackagedResources = false;
  let addonSignature: ReturnType<typeof verifyCodeSignature> = {
    verified: false,
    kind: "unverified",
    detail: "not checked",
  };
  let appSignature: ReturnType<typeof verifyCodeSignature> = {
    verified: false,
    kind: "unverified",
    detail: "not checked",
  };
  let ffmpegPathWasPackaged = false;
  let addonPath = "";
  let ffmpegPath = "";
  let outputPath = "";
  let addonHash = "";
  let ffmpegHash = "";
  let electronTexturesReceived = 0;
  let electronTexturesReleased = 0;

  try {
    process.stderr.write("[shared-texture-probe] checking packaged environment\n");
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("probe requires packaged Electron on macOS arm64");
    }
    if (!app.isPackaged) throw new Error("probe must run from a packaged Electron application");

    addonPath = nativeSharedTextureProbeAddonPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: "",
    });
    addonLoadedFromPackagedResources = addonPath.startsWith(
      path.join(process.resourcesPath, "native", "macos"),
    );
    ffmpegPath = ffmpegExecutablePath();
    ffmpegPathWasPackaged = ffmpegPath.includes(`${path.sep}app.asar.unpacked${path.sep}`);
    addonHash = await sha256(addonPath);
    ffmpegHash = await sha256(ffmpegPath);
    process.stderr.write("[shared-texture-probe] hashed packaged addon and FFmpeg\n");
    addonSignature = verifyCodeSignature(addonPath);
    appSignature = verifyCodeSignature(packagedAppPath());
    commandOutput(ffmpegPath, ["-version"]);
    process.stderr.write("[shared-texture-probe] signatures and FFmpeg launch verified\n");

    const addon = loadNativeSharedTextureProbe(addonPath);
    process.stderr.write("[shared-texture-probe] native addon loaded\n");
    outputPath = path.join(os.tmpdir(), `storycapture-shared-texture-probe-${process.pid}.mkv`);
    session = addon.createSession({
      width: SHARED_TEXTURE_PROBE_WIDTH,
      height: SHARED_TEXTURE_PROBE_HEIGHT,
      ffmpegPath,
      outputPath,
    });
    process.stderr.write("[shared-texture-probe] native session created\n");

    const fixturePath = path.join(
      process.resourcesPath,
      "native",
      "macos",
      "shared-texture-probe-fixture.html",
    );
    const window = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      width: 960,
      height: 540,
      webPreferences: {
        partition: `storycapture-shared-texture-probe-${process.pid}`,
        offscreen: {
          useSharedTexture: true,
          sharedTexturePixelFormat: "argb",
          deviceScaleFactor: 2,
        },
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    process.stderr.write("[shared-texture-probe] offscreen window created\n");
    window.webContents.setFrameRate(60);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("600-frame probe timed out")), 30_000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        window.webContents.off("paint", onPaint);
        if (!window.isDestroyed()) window.destroy();
        if (error) reject(error);
        else resolve();
      };
      const onPaint = (event: Electron.Event) => {
        if (receipts.length >= SHARED_TEXTURE_PROBE_FRAME_COUNT) return;
        const texture = (event as Electron.Event & { texture?: Electron.OffscreenSharedTexture })
          .texture;
        if (!texture || texture.textureInfo.widgetType !== "frame") return;
        electronTexturesReceived += 1;
        const { codedSize, handle, metadata, pixelFormat, timestamp } = texture.textureInfo;
        try {
          if (pixelFormat !== "bgra") throw new Error(`unexpected texture format ${pixelFormat}`);
          if (codedSize.width !== SHARED_TEXTURE_PROBE_WIDTH || codedSize.height !== 1080) {
            codedSizeMatches = false;
            throw new Error(`unexpected coded size ${codedSize.width}x${codedSize.height}`);
          }
          if (!handle.ioSurface) throw new Error("Electron paint omitted the ioSurface handle");
          const frameCount = metadata.frameCount;
          if (typeof frameCount !== "number" || !Number.isSafeInteger(frameCount)) {
            throw new Error("Electron paint omitted metadata.frameCount");
          }
          if (!Number.isSafeInteger(timestamp))
            throw new Error("Electron paint timestamp is invalid");
          const receipt = session?.submitFrame({
            ioSurface: handle.ioSurface,
            frameCount,
            timestampUs: timestamp,
          });
          if (!receipt) throw new Error("native probe session was unavailable");
          receipts.push(receipt);
          if (receipts.length % 60 === 0) {
            process.stderr.write(`[shared-texture-probe] accepted ${receipts.length} frames\n`);
          }
          jsFrameBytes += 0;
          if (receipts.length === SHARED_TEXTURE_PROBE_FRAME_COUNT) finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        } finally {
          texture.release();
          electronTexturesReleased += 1;
        }
      };
      window.webContents.on("paint", onPaint);
      process.stderr.write(`[shared-texture-probe] loading fixture ${fixturePath}\n`);
      window.loadFile(fixturePath).catch((error) => finish(error));
    });
    process.stderr.write("[shared-texture-probe] finishing native session\n");
    stats = session.finish();
    process.stderr.write("[shared-texture-probe] native session finished\n");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[shared-texture-probe] run failed ${reason}\n`);
    failures.push(reason);
    if (session) stats = session.abort();
    else stats = blankStats(reason);
  } finally {
    if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }

  const gate = evaluateSharedTextureProbeGate({
    receipts,
    stats,
    jsFrameBytes,
    electronTexturesReceived,
    electronTexturesReleased,
    codedSizeMatches,
    addonLoadedFromPackagedResources,
    addonSignatureVerified: addonSignature.verified,
    appSignatureVerified: appSignature.verified,
    ffmpegPathWasPackaged,
  });
  failures.push(...gate.failures);
  const environment = {
    hardwareModel: commandOutput("/usr/sbin/sysctl", ["-n", "hw.model"]),
    machine: commandOutput("/usr/bin/uname", ["-m"]),
    memoryBytes: Number(commandOutput("/usr/sbin/sysctl", ["-n", "hw.memsize"])),
    cpuCount: Number(commandOutput("/usr/sbin/sysctl", ["-n", "hw.ncpu"])),
    macosProductVersion: commandOutput("/usr/bin/sw_vers", ["-productVersion"]),
    macosBuildVersion: commandOutput("/usr/bin/sw_vers", ["-buildVersion"]),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    napiVersion: process.versions.napi,
    codeSigningIdentities: commandOutput("/usr/bin/security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
    ]),
  };
  return {
    passed: gate.passed && failures.length === 0,
    report: {
      version: REPORT_VERSION,
      generatedAt: new Date().toISOString(),
      status: gate.passed && failures.length === 0 ? "passed" : "failed",
      certifiedProfileAdded: false,
      environment,
      contract: {
        frames: SHARED_TEXTURE_PROBE_FRAME_COUNT,
        width: SHARED_TEXTURE_PROBE_WIDTH,
        height: SHARED_TEXTURE_PROBE_HEIGHT,
        fps: "60/1",
        maxServiceTimeP95Ms: SHARED_TEXTURE_PROBE_P95_LIMIT_MS,
        maxServiceTimeP99Ms: SHARED_TEXTURE_PROBE_P99_LIMIT_MS,
        maxReadyQueueDepth: 1,
        maxResidentGrowthBytes: SHARED_TEXTURE_PROBE_MEMORY_GROWTH_LIMIT_BYTES,
      },
      binaries: {
        packagedAppPath: packagedAppPath(),
        addonPath,
        addonSha256: addonHash,
        addonSignature,
        ffmpegPath,
        ffmpegSha256: ffmpegHash,
        ffmpegPathWasPackaged,
        appSignature,
      },
      evidence: {
        ...gate,
        jsFrameBytes,
        electronTexturesReceived,
        electronTexturesReleased,
        codedSizeMatches,
        addonLoadedFromPackagedResources,
        stats,
      },
      failures,
    },
  };
}

if (!reportPath) {
  process.stderr.write("STORYCAPTURE_SHARED_TEXTURE_PROBE_REPORT is required\n");
  app.exit(1);
} else {
  app.whenReady().then(async () => {
    process.stderr.write("[shared-texture-probe] Electron ready\n");
    let exitCode = 1;
    try {
      await writeReport({
        version: REPORT_VERSION,
        generatedAt: new Date().toISOString(),
        status: "running",
        certifiedProfileAdded: false,
        failures: [],
      });
      const result = await runProbe();
      process.stderr.write(
        `[shared-texture-probe] capture status=${result.passed ? "passed" : "failed"}\n`,
      );
      await writeReport(result.report);
      process.stderr.write(`[shared-texture-probe] wrote report ${reportPath}\n`);
      exitCode = result.passed ? 0 : 1;
    } catch (error) {
      process.stderr.write(
        `[shared-texture-probe] fatal ${error instanceof Error ? error.stack : String(error)}\n`,
      );
      await writeReport({
        version: REPORT_VERSION,
        generatedAt: new Date().toISOString(),
        status: "failed",
        certifiedProfileAdded: false,
        failures: [error instanceof Error ? error.message : String(error)],
      }).catch(() => undefined);
    } finally {
      process.stderr.write(`[shared-texture-probe] exiting ${exitCode}\n`);
      app.exit(exitCode);
    }
  });
}

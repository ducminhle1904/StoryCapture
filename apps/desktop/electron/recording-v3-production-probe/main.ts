import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { ffmpegExecutablePath, ffprobeExecutablePath } from "../ipc/export-binaries";
import { BrowserCaptureBackendV3 } from "../ipc/recording-v3-browser-backend";
import { canonicalizeRecordingCertificationJson } from "../ipc/recording-v3-certification-canonical-json";
import {
  bindRecordingV3EvidenceBuffer,
  bindRecordingV3EvidenceFile,
  createRecordingV3CertificationEvidenceArtifact,
} from "../ipc/recording-v3-certification-evidence";
import {
  decodeRecordingV3CertificationMasterFrames,
  decodeRecordingV3FixtureOrdinal,
  type RecordingV3BrowserCertificationFixture,
  verifyRecordingV3CertificationQuality,
} from "../ipc/recording-v3-certification-quality";
import {
  RecordingV3Engine,
  RecordingV3EngineError,
  verifyRecordingV3Artifact,
} from "../ipc/recording-v3-engine";
import {
  loadRecordingV3NativeAddon,
  RecordingV3NativeBridge,
  recordingV3NativeAddonPath,
} from "../ipc/recording-v3-native-addon";

interface ProbeOptions {
  certification: boolean;
  durationSeconds: number;
  frameCount: number;
  fixture: "static" | "motion";
  fixtureUrl: string | null;
  pressureMode: "none" | "cpu" | "disk" | "cpu-disk";
  scenario: "steady" | "lifecycle" | "target-loss" | "gpu-loss";
  artifactDir: string | null;
  reportPath: string;
}

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = value === null ? fallback : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("invalid positive integer");
  return parsed;
}

function probeOptions(): ProbeOptions {
  const certification = process.argv.includes("--recording-v3-certification");
  const durationSeconds = positiveInteger(argumentValue("--duration-seconds"), 10);
  const fixture = argumentValue("--fixture-url")?.includes("fixture=static") ? "static" : "motion";
  const pressureMode = (argumentValue("--pressure-mode") ?? "none") as ProbeOptions["pressureMode"];
  const scenario = (argumentValue("--scenario") ?? "steady") as ProbeOptions["scenario"];
  if (!new Set(["none", "cpu", "disk", "cpu-disk"]).has(pressureMode)) {
    throw new Error("invalid pressure mode");
  }
  if (!new Set(["steady", "lifecycle", "target-loss", "gpu-loss"]).has(scenario)) {
    throw new Error("invalid certification scenario");
  }
  const artifactDir = certification ? argumentValue("--artifact-dir") : null;
  const reportPath =
    process.env.STORYCAPTURE_RECORDING_V3_PROBE_REPORT ?? argumentValue("--json-summary") ?? "";
  return {
    certification,
    durationSeconds,
    frameCount: certification ? durationSeconds * 60 : 600,
    fixture,
    fixtureUrl: certification ? argumentValue("--fixture-url") : null,
    pressureMode,
    scenario,
    artifactDir,
    reportPath,
  };
}

const options = probeOptions();
const reportPath = options.reportPath;

process.stderr.write("[recording-v3] packaged probe module loaded\n");

app.on("window-all-closed", () => {
  // The hidden probe window closes before native stop/decode verification finishes.
});

async function writeReport(report: unknown): Promise<void> {
  if (!reportPath) throw new Error("STORYCAPTURE_RECORDING_V3_PROBE_REPORT is required");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function ffprobeFrameCount(binary: string, artifactPath: string): number {
  const result = spawnSync(
    binary,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "default=nokey=1:noprint_wrappers=1",
      artifactPath,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`FFmpeg artifact frame probe failed: ${result.stderr.trim()}`);
  }
  const count = Number(result.stdout.trim());
  if (!Number.isSafeInteger(count)) throw new Error("FFmpeg artifact frame count was invalid");
  return count;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function commandText(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function runtimeIdentity(input: {
  addonPath: string;
  ffmpegPath: string;
  evidenceArtifactSha256: string | null;
}) {
  return {
    target_class: "browser",
    platform: "darwin",
    arch: process.arch,
    hardware_model: commandText("/usr/sbin/sysctl", ["-n", "hw.model"]),
    hardware_chip: commandText("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
    os_build: commandText("/usr/bin/sw_vers", ["-buildVersion"]),
    backend_id: "electron_offscreen_shared_texture_v3",
    backend_version: "3.0.0",
    addon_protocol_version: 3,
    addon_sha256: await sha256File(input.addonPath),
    electron_version: process.versions.electron,
    chromium_version: process.versions.chrome,
    ffmpeg_version: commandText(input.ffmpegPath, ["-version"]).split("\n", 1)[0]?.trim(),
    ffmpeg_sha256: await sha256File(input.ffmpegPath),
    output_width: 1920,
    output_height: 1080,
    exact_fps: { numerator: 60, denominator: 1 },
    cursor_policy: "sidecar_reconstructed",
    audio_roles: [],
    evidence_artifact_sha256: input.evidenceArtifactSha256,
  };
}

function rgbaToBgra(value: Uint8Array): Buffer {
  const result = Buffer.from(value);
  for (let offset = 0; offset < result.byteLength; offset += 4) {
    const red = result[offset];
    result[offset] = result[offset + 2];
    result[offset + 2] = red;
  }
  return result;
}

const boundaryWaitState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function waitUntilMonotonicNs(deadlineNs: bigint): void {
  while (true) {
    const remainingNs = deadlineNs - process.hrtime.bigint();
    if (remainingNs <= 0n) return;
    if (remainingNs > 2_000_000n) {
      const sleepMs = Math.max(1, Number(remainingNs / 1_000_000n) - 1);
      Atomics.wait(boundaryWaitState, 0, 0, sleepMs);
    }
  }
}

async function renderCertificationReferenceFrame(
  fixtureUrl: string,
  ordinal: number,
): Promise<Buffer> {
  const url = new URL(fixtureUrl);
  url.searchParams.set("startOrdinal", String(ordinal));
  url.searchParams.set("freezeOrdinal", "1");
  const window = new BrowserWindow({
    show: false,
    width: 960,
    height: 540,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadURL(url.href);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const expectedOrdinal = ${JSON.stringify(ordinal)};
      const deadline = performance.now() + 5000;
      const check = () => {
        if (window.__storyCaptureRecordingV3Fixture?.ordinal === expectedOrdinal) {
          resolve(true);
        } else if (performance.now() >= deadline) {
          reject(new Error("certification reference fixture did not render the requested ordinal"));
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    })`);
    const bytes = await window.webContents.executeJavaScript(`(() => {
      const canvas = document.getElementById("fixture");
      const context = canvas.getContext("2d", { alpha: false });
      return new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data);
    })()`);
    const rgba = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as number[]);
    if (rgba.byteLength !== 1920 * 1080 * 4) {
      throw new Error(`Certification reference frame had ${rgba.byteLength} bytes.`);
    }
    return rgbaToBgra(rgba);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function createCertificationEvidence(input: {
  fixtureUrl: string;
  masterPath: string;
  ffmpegPath: string;
  frameCount: number;
  artifactDir: string;
}) {
  const fixturePath = fileURLToPath(new URL("./fixture.json", input.fixtureUrl));
  const fixture = JSON.parse(
    await fs.readFile(fixturePath, "utf8"),
  ) as RecordingV3BrowserCertificationFixture;
  const candidateOrdinals = [
    0,
    Math.floor((input.frameCount - 1) / 2),
    input.frameCount - 1,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const candidateFrames = await decodeRecordingV3CertificationMasterFrames({
    ffmpeg_path: input.ffmpegPath,
    master_path: input.masterPath,
    width: 1920,
    height: 1080,
    ordinals: candidateOrdinals,
  });
  const embeddedOrdinals = candidateFrames.map((frame) =>
    decodeRecordingV3FixtureOrdinal(frame.bgra, fixture),
  );
  const referenceFrames: Buffer[] = [];
  for (const ordinal of embeddedOrdinals) {
    referenceFrames.push(await renderCertificationReferenceFrame(input.fixtureUrl, ordinal));
  }
  const referenceBytes = Buffer.concat(referenceFrames);
  const referenceSha256 = createHash("sha256").update(referenceBytes).digest("hex");
  const qualityEvidence = verifyRecordingV3CertificationQuality({
    fixture,
    reference_identity: {
      fixture_id: fixture.fixture_id,
      fixture_version: fixture.fixture_version,
      reference_sha256: referenceSha256,
    },
    frames: candidateFrames.map((candidate, index) => ({
      ordinal: embeddedOrdinals[index],
      reference: referenceFrames[index],
      candidate: candidate.bgra,
    })),
  });
  const qualityJson = canonicalizeRecordingCertificationJson(qualityEvidence);
  const referencePath = path.join(input.artifactDir, "reference-selected-frames.bgra");
  const qualityPath = path.join(input.artifactDir, "quality-evidence.json");
  await Promise.all([
    fs.writeFile(referencePath, referenceBytes),
    fs.writeFile(qualityPath, qualityJson, "utf8"),
  ]);
  const evidence = createRecordingV3CertificationEvidenceArtifact({
    fixture_id: fixture.fixture_id,
    fixture_version: fixture.fixture_version,
    generated_at: new Date().toISOString(),
    inputs: [
      bindRecordingV3EvidenceBuffer({
        role: "reference_master",
        file_name: path.basename(referencePath),
        measurement_scope: "certification_fixture",
        value: referenceBytes,
      }),
      await bindRecordingV3EvidenceFile({
        role: "candidate_master",
        file_path: input.masterPath,
        measurement_scope: "certification_fixture",
      }),
    ],
    outputs: [
      bindRecordingV3EvidenceBuffer({
        role: "quality_evidence",
        file_name: path.basename(qualityPath),
        measurement_scope: "certification_fixture",
        value: Buffer.from(qualityJson),
      }),
    ],
    quality_evidence: qualityEvidence,
  });
  const evidencePath = path.join(input.artifactDir, "evidence.json");
  await fs.writeFile(evidencePath, evidence.canonical_json, "utf8");
  return {
    evidencePath,
    evidenceSha256: evidence.sha256,
    qualityEvidence,
    javascriptReferenceBytes: referenceBytes.byteLength,
  };
}

async function recordFixture(): Promise<unknown> {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !app.isPackaged) {
    throw new Error("Recording V3 production probe requires packaged macOS arm64 Electron");
  }
  const addonPath = recordingV3NativeAddonPath({
    isPackaged: true,
    resourcesPath: process.resourcesPath,
    desktopRoot: "",
  });
  const ffmpegPath = ffmpegExecutablePath();
  const ffprobePath = ffprobeExecutablePath();
  const outputRoot = options.artifactDir ?? os.tmpdir();
  await fs.mkdir(outputRoot, { recursive: true });
  const outputPath = path.join(outputRoot, `storycapture-recording-v3-${process.pid}.mkv`);
  const proxyPath = path.join(outputRoot, `storycapture-recording-v3-${process.pid}.mp4`);
  const bridge = new RecordingV3NativeBridge(loadRecordingV3NativeAddon(addonPath));
  const probe = bridge.probe();
  const native = bridge.start({
    width: 1920,
    height: 1080,
    ffmpegPath,
    outputPath,
  });
  process.stderr.write("[recording-v3] native session started\n");
  const engine = new RecordingV3Engine(native);
  const backend = new BrowserCaptureBackendV3(engine);
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: 960,
    height: 540,
    webPreferences: {
      partition: `storycapture-recording-v3-${process.pid}`,
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
  window.webContents.setFrameRate(60);
  window.webContents.stopPainting();
  const expectedFailureCode =
    options.scenario === "target-loss"
      ? "target_lost"
      : options.scenario === "gpu-loss"
        ? "native_texture_lost"
        : null;
  let pauseInjected = false;
  let reloadInjected = false;
  let acceptingFrames = false;
  let firstDeliveryStartedAtNs: bigint | null = null;
  let pauseStartedAtNs: bigint | null = null;
  let accumulatedPausedNs = 0n;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${options.frameCount}-frame production probe timed out`)),
        options.durationSeconds * 1_000 + 90_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        window.webContents.off("paint", onPaint);
        if (!window.isDestroyed()) window.destroy();
        if (error) reject(error);
        else resolve();
      };
      const onPaint = (event: Electron.Event) => {
        if (backend.textureCounts.received >= options.frameCount) return;
        const texture = (event as Electron.Event & { texture?: Electron.OffscreenSharedTexture })
          .texture;
        if (!texture) return;
        if (!acceptingFrames || texture.textureInfo.widgetType !== "frame") {
          texture.release();
          return;
        }
        try {
          if (firstDeliveryStartedAtNs === null) firstDeliveryStartedAtNs = process.hrtime.bigint();
          backend.submitTexture(texture);
          const received = backend.textureCounts.received;
          if (received % 60 === 0) process.stderr.write(`[recording-v3] accepted ${received}\n`);
          if (expectedFailureCode && received === Math.min(60, options.frameCount)) {
            engine.fail(expectedFailureCode, `injected ${options.scenario} certification fault`);
          }
          if (
            options.scenario === "lifecycle" &&
            !pauseInjected &&
            received >= Math.floor(options.frameCount / 3)
          ) {
            pauseInjected = true;
            window.webContents.stopPainting();
            pauseStartedAtNs = process.hrtime.bigint();
            engine.pause();
            setTimeout(() => {
              try {
                engine.resume();
                if (pauseStartedAtNs !== null) {
                  accumulatedPausedNs += process.hrtime.bigint() - pauseStartedAtNs;
                  pauseStartedAtNs = null;
                }
                window.webContents.startPainting();
                window.webContents.invalidate();
              } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
              }
            }, 250).unref?.();
          }
          if (
            options.scenario === "lifecycle" &&
            pauseInjected &&
            !reloadInjected &&
            received >= Math.floor((options.frameCount * 2) / 3)
          ) {
            reloadInjected = true;
            engine.closeEpoch();
          }
          if (received === options.frameCount) {
            window.webContents.off("paint", onPaint);
            window.webContents.stopPainting();
            if (firstDeliveryStartedAtNs === null) {
              finish(new Error("Recording V3 certification scheduler origin was unavailable"));
              return;
            }
            const finalPtsNs =
              BigInt(Math.round(((options.frameCount - 1) * 1_000_000) / 60)) * 1_000n;
            waitUntilMonotonicNs(firstDeliveryStartedAtNs + accumulatedPausedNs + finalPtsNs);
            finish();
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      window.webContents.on("paint", onPaint);
      if (options.fixtureUrl) {
        process.stderr.write(`[recording-v3] loading fixture ${options.fixtureUrl}\n`);
        window
          .loadURL(options.fixtureUrl)
          .then(() =>
            window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
              const deadline = performance.now() + 5000;
              const check = () => {
                if (window.__storyCaptureRecordingV3Fixture) resolve(true);
                else if (performance.now() >= deadline) reject(new Error("fixture readiness timed out"));
                else requestAnimationFrame(check);
              };
              check();
            })`),
          )
          .then(() => {
            acceptingFrames = true;
            window.webContents.startPainting();
            window.webContents.invalidate();
          })
          .catch((error) => finish(error));
      } else {
        const fixturePath = path.join(
          process.resourcesPath,
          "native",
          "macos",
          "shared-texture-probe-fixture.html",
        );
        process.stderr.write(`[recording-v3] loading fixture ${fixturePath}\n`);
        window
          .loadFile(fixturePath)
          .then(() => {
            acceptingFrames = true;
            window.webContents.startPainting();
            window.webContents.invalidate();
          })
          .catch((error) => finish(error));
      }
    });

    process.stderr.write("[recording-v3] capture complete; reconciling exact scheduler stop\n");
    const engineResult = engine.stop();
    process.stderr.write(
      "[recording-v3] native stop complete; starting full decode/proxy verification\n",
    );
    const verified = await verifyRecordingV3Artifact({
      engineResult,
      masterPath: outputPath,
      proxyPath,
      width: 1920,
      height: 1080,
      ffmpegBinary: ffmpegPath,
    });
    process.stderr.write("[recording-v3] full decode/proxy verification complete\n");
    const decodedFrames = ffprobeFrameCount(ffprobePath, outputPath);
    const certificationEvidence =
      options.certification && options.fixtureUrl && options.artifactDir
        ? await createCertificationEvidence({
            fixtureUrl: options.fixtureUrl,
            masterPath: outputPath,
            ffmpegPath,
            frameCount: options.frameCount,
            artifactDir: options.artifactDir,
          })
        : null;
    const counts = backend.textureCounts;
    const passed =
      counts.received === options.frameCount &&
      counts.released === options.frameCount &&
      backend.jsFrameBytes === 0 &&
      engineResult.stats.handlesImported === options.frameCount &&
      engineResult.stats.handlesReleased === options.frameCount &&
      engineResult.stats.activeLeases === 0 &&
      engineResult.stats.nativeCommits === options.frameCount &&
      engineResult.stats.encodedFrames === options.frameCount &&
      engineResult.stats.leaseOverflows === 0 &&
      engineResult.stats.backpressureEvents === 0 &&
      engineResult.stats.deadlineMisses === 0 &&
      engineResult.stats.maxQueueDepth <= 1 &&
      engineResult.stats.maxReadyQueueDepth <= 1 &&
      engineResult.stats.leaseAdmissionWaitMaxMs <= 11.11 &&
      engineResult.stats.serviceTimeP95Ms <= 11.11 &&
      engineResult.stats.serviceTimeP99Ms <= 16.67 &&
      decodedFrames === options.frameCount &&
      verified.ledger.length === options.frameCount &&
      verified.cadenceEvidence.verdict === "passed" &&
      verified.runtimeQualityEvidence.lossless_master_hashes_match === true &&
      (certificationEvidence === null ||
        certificationEvidence.qualityEvidence.certification_verdict === "passed");
    return {
      passed,
      duration_seconds: options.durationSeconds,
      fixture: options.fixture,
      pressure_mode: options.pressureMode,
      scenario: options.scenario,
      protocol: probe,
      addonPath,
      ffmpegPath,
      ffprobePath,
      outputPath,
      proxyPath,
      electronTexturesReceived: counts.received,
      electronTexturesReleased: counts.released,
      jsFrameBytes: backend.jsFrameBytes,
      native: engineResult.stats,
      decodedFrames,
      ledgerFrames: verified.ledger.length,
      cadence: verified.cadenceEvidence,
      runtimeQuality: verified.runtimeQualityEvidence,
      certificationQuality: certificationEvidence?.qualityEvidence ?? null,
      certificationEvidencePath: certificationEvidence?.evidencePath ?? null,
      certificationEvidenceSha256: certificationEvidence?.evidenceSha256 ?? null,
      certificationJsReferenceBytes: certificationEvidence?.javascriptReferenceBytes ?? 0,
      runtimeIdentity: await runtimeIdentity({
        addonPath,
        ffmpegPath,
        evidenceArtifactSha256: certificationEvidence?.evidenceSha256 ?? null,
      }),
    };
  } catch (error) {
    const diagnostics = {
      textureCounts: backend.textureCounts,
      native: native.getStats(),
    };
    process.stderr.write(`[recording-v3] failure diagnostics ${JSON.stringify(diagnostics)}\n`);
    engine.abort();
    if (
      expectedFailureCode &&
      error instanceof RecordingV3EngineError &&
      error.code === expectedFailureCode
    ) {
      const nativeStats = native.getStats();
      return {
        passed:
          nativeStats.handlesImported === nativeStats.handlesReleased &&
          nativeStats.activeLeases === 0,
        duration_seconds: options.durationSeconds,
        fixture: options.fixture,
        pressure_mode: options.pressureMode,
        scenario: options.scenario,
        expected_failure_code: expectedFailureCode,
        expected_failure_observed: true,
        diagnostics: { textureCounts: backend.textureCounts, native: nativeStats },
      };
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    Object.assign(failure, { recordingV3Diagnostics: diagnostics });
    throw failure;
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

app.whenReady().then(async () => {
  process.stderr.write("[recording-v3] Electron app ready\n");
  try {
    const report = await recordFixture();
    await writeReport(report);
    process.stderr.write(`[recording-v3] report written ${reportPath}\n`);
    const artifacts = report as { outputPath?: string; proxyPath?: string };
    if (!options.certification) {
      await Promise.all(
        [artifacts.outputPath, artifacts.proxyPath]
          .filter((value): value is string => typeof value === "string")
          .map((filePath) => fs.rm(filePath, { force: true })),
      );
    }
    app.exit((report as { passed: boolean }).passed ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const diagnostics =
      typeof error === "object" && error !== null && "recordingV3Diagnostics" in error
        ? (error as { recordingV3Diagnostics: unknown }).recordingV3Diagnostics
        : null;
    process.stderr.write(`[recording-v3] ${message}\n`);
    try {
      await writeReport({ passed: false, phase: "runtime", failure: message, diagnostics });
    } finally {
      app.exit(1);
    }
  }
});

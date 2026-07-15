import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { createRecordingSpikeTrace } from "./recording-spike-trace.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(desktopDir, "../..");
const swiftSources = [
  path.join(desktopDir, "native/spikes/macos-capture/protocol.swift"),
  path.join(desktopDir, "native/spikes/macos-capture/main.swift"),
];
const temporaryRoot = path.join(os.tmpdir(), "storycapture-native-spikes");

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--") continue;
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (["--request-permission", "--quick", "--no-electron-control"].includes(key)) {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    values.set(key, value);
    index += 1;
  }
  const kind = values.get("--kind") ?? "native-capture";
  if (!new Set(["native-capture", "system-audio"]).has(kind)) {
    throw new Error(`unsupported spike kind: ${kind}`);
  }
  const durationScale = Number(
    values.get("--duration-scale") ?? (flags.has("--quick") ? "0.01" : "1"),
  );
  if (!Number.isFinite(durationScale) || durationScale <= 0 || durationScale > 1) {
    throw new Error("duration-scale must be within (0, 1]");
  }
  const matrix = (
    values.get("--matrix") ??
    (kind === "system-audio" ? "permissions,timing,performance,packaging" : "baseline")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const profiles = (values.get("--profiles") ?? "1080p30,1440p30,4k30")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    kind,
    matrix,
    profiles,
    durationScale,
    requestPermission: flags.has("--request-permission"),
    electronControl: !flags.has("--no-electron-control"),
    output: values.get("--output") ?? null,
  };
}

function safeRunID(value) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 96) throw new Error(`unsafe run id: ${value}`);
  return normalized;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

async function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? desktopDir,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.on("error", (error) => resolve({ code: null, signal: null, stdout, stderr, error }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
}

async function buildHarness(batchDirectory) {
  const binary = path.join(batchDirectory, "storycapture-macos-capture-spike");
  const args = [
    "swiftc",
    "-parse-as-library",
    "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos13.0`,
    ...swiftSources,
    "-o",
    binary,
  ];
  const result = await run("xcrun", args, { cwd: repoRoot });
  if (result.code !== 0) {
    throw new Error(`Swift harness build failed\n${result.stderr || result.stdout}`);
  }
  return { binary, exactCommand: ["xcrun", ...args] };
}

async function signingEvidence(binary) {
  const identities = await run("security", ["find-identity", "-v", "-p", "codesigning"], {
    cwd: repoRoot,
  });
  const codeSignature = await run("codesign", ["-dvvv", binary], { cwd: repoRoot });
  const identityCount = Number(identities.stdout.match(/(\d+) valid identities found/)?.[1] ?? 0);
  return {
    valid_identity_count: identityCount,
    identities: identities.stdout.trim(),
    harness_codesign_exit: codeSignature.code,
    harness_codesign_detail: (codeSignature.stderr || codeSignature.stdout).trim(),
  };
}

function parseEnvelope(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.version === 1 && typeof parsed.type === "string") return parsed;
    } catch {
      // Non-protocol stdout is retained as diagnostics but never trusted.
    }
  }
  return null;
}

function psMetrics(pid) {
  const result = spawnSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const [cpu, rssKB] = result.stdout.trim().split(/\s+/).map(Number);
  return Number.isFinite(cpu) && Number.isFinite(rssKB) ? { cpu, rssMB: rssKB / 1024 } : null;
}

async function runMeasuredHarness(binary, args, timeoutMs) {
  const child = spawn(binary, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 2 * 1024 * 1024) child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 2 * 1024 * 1024) child.kill("SIGKILL");
  });
  const cpu = [];
  const rss = [];
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }, timeoutMs);
  deadline.unref();
  const timer = setInterval(() => {
    const metrics = psMetrics(child.pid);
    if (metrics) {
      cpu.push(metrics.cpu);
      rss.push(metrics.rssMB);
    }
  }, 250);
  timer.unref();
  const completion = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(deadline);
  clearInterval(timer);
  return {
    status: completion.code === 0 && !timedOut ? "passed" : "failed",
    exit_code: completion.code,
    signal: completion.signal,
    timed_out: timedOut,
    timeout_ms: timeoutMs,
    spawn_error: completion.error?.message ?? null,
    protocol: parseEnvelope(stdout),
    stderr: stderr.trim(),
    stdout_non_protocol: stdout
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("{"))
      .join("\n")
      .slice(0, 16_384),
    cpu_p50: percentile(cpu, 0.5),
    cpu_p95: percentile(cpu, 0.95),
    peak_rss_mb: Math.max(0, ...rss),
    exact_command: [binary, ...args],
  };
}

async function startFixture(binary, batchID, width, height) {
  const runID = safeRunID(`${batchID}-fixture`);
  const args = [
    "--fixture-window",
    "--run-id",
    runID,
    "--width",
    String(width),
    "--height",
    String(height),
  ];
  const child = spawn(binary, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const envelope = await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`fixture window did not start: ${stderr}`)),
      15_000,
    );
    const poll = setInterval(() => {
      const parsed = parseEnvelope(stdout);
      if (parsed?.type === "fixture_ready") {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve(parsed);
      } else if (child.exitCode != null) {
        clearTimeout(deadline);
        clearInterval(poll);
        reject(new Error(`fixture window exited early: ${stderr || stdout}`));
      }
    }, 50);
  });
  return {
    child,
    runID,
    title: envelope.payload.title,
    pid: envelope.payload.pid,
    exactCommand: [binary, ...args],
  };
}

async function stopFixture(fixture) {
  if (!fixture || fixture.child.exitCode != null) return;
  fixture.child.kill("SIGTERM");
  await new Promise((resolve) => {
    const force = setTimeout(() => {
      fixture.child.kill("SIGKILL");
      resolve();
    }, 3000);
    fixture.child.once("close", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

async function probeMedia(mediaPath) {
  if (!mediaPath || !ffmpegPath)
    return { status: "unavailable", detail: "media path or ffmpeg missing" };
  const result = await run(ffmpegPath, ["-hide_banner", "-i", mediaPath], { cwd: repoRoot });
  const detail = `${result.stdout}\n${result.stderr}`;
  const duration = detail.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSeconds = duration
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    : null;
  return {
    status: /Video:/.test(detail) || /Audio:/.test(detail) ? "valid" : "invalid",
    has_video: /Video:/.test(detail),
    has_audio: /Audio:/.test(detail),
    duration_seconds: durationSeconds,
    detail: detail
      .split("\n")
      .filter((line) => /Duration:|Stream #/.test(line))
      .join("\n"),
    exact_command: [ffmpegPath, "-hide_banner", "-i", mediaPath],
  };
}

const profileDefinitions = {
  "1080p30": { width: 1920, height: 1080, fps: 30, durationMs: 600_000, required: true },
  "1440p30": { width: 2560, height: 1440, fps: 30, durationMs: 300_000, required: true },
  "4k30": { width: 3840, height: 2160, fps: 30, durationMs: 120_000, required: false },
};

function scaledDuration(durationMs, scale) {
  return Math.max(1000, Math.round(durationMs * scale));
}

async function runElectronControl({
  batchDirectory,
  batchID,
  tracePath,
  fixture,
  profileName,
  profile,
  durationMs,
}) {
  const resultPath = path.join(batchDirectory, `${profileName}-electron-control.json`);
  const config = {
    runId: safeRunID(`${batchID}-${profileName}-electron`),
    title: fixture.title,
    width: profile.width,
    height: profile.height,
    fps: profile.fps,
    durationMs,
    resultPath,
    tracePath:
      process.env.STORYCAPTURE_RECORD_ENGINE_JSONL === "0" ? null : tracePath,
  };
  const exactCommand = [
    "pnpm",
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.config.ts",
    "e2e/macos-native-capture-control.spec.ts",
    "--workers=1",
  ];
  const result = await run(exactCommand[0], exactCommand.slice(1), {
    cwd: desktopDir,
    env: {
      ...process.env,
      STORYCAPTURE_NATIVE_SPIKE_CONTROL: JSON.stringify(config),
    },
  });
  let payload = null;
  try {
    payload = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch {
    payload = {
      status: "failed",
      failure_reason: "control_result_missing",
      detail: (result.stderr || result.stdout).slice(-16_384),
    };
  }
  return {
    ...payload,
    playwright_exit_code: result.code,
    exact_command: exactCommand,
  };
}

async function runNativeCase({
  binary,
  batchID,
  name,
  profile,
  durationMs,
  target = "window",
  fixture,
  transport = "host_frames",
  audio = false,
  cursor = true,
  requestPermission = false,
}) {
  const runID = safeRunID(`${batchID}-${name}`);
  const args = [
    "--run-id",
    runID,
    "--target",
    target,
    "--transport",
    transport,
    "--width",
    String(profile.width),
    "--height",
    String(profile.height),
    "--fps",
    String(profile.fps),
    "--duration-ms",
    String(durationMs),
  ];
  if (fixture && target === "window")
    args.push("--pid", String(fixture.pid), "--title", fixture.title);
  if (audio) args.push("--audio");
  if (!cursor) args.push("--no-cursor");
  if (requestPermission) args.push("--request-permission");
  const result = await runMeasuredHarness(binary, args, durationMs + 10_000);
  const payload = result.protocol?.payload ?? null;
  const segmentProbe = await probeMedia(payload?.backend_segment_path ?? null);
  const audioProbe = await probeMedia(
    payload?.audio?.outputPath ?? payload?.audio?.output_path ?? null,
  );
  return { name, ...result, segment_probe: segmentProbe, audio_probe: audioProbe };
}

async function nativeCaptureMatrix(config, context) {
  const results = [];
  const requestedProfiles = config.profiles.map((name) => {
    const profile = profileDefinitions[name];
    if (!profile) throw new Error(`unknown profile: ${name}`);
    return [name, profile];
  });
  let fixture = null;
  try {
    fixture = await startFixture(context.binary, context.batchID, 1600, 900);
    context.fixture = {
      run_id: fixture.runID,
      title: fixture.title,
      pid: fixture.pid,
      exact_command: fixture.exactCommand,
    };
    if (config.matrix.includes("baseline")) {
      if (config.electronControl) {
        const built = await run("pnpm", ["electron:build-main"], { cwd: desktopDir });
        context.electron_build = {
          exit_code: built.code,
          stderr: built.stderr.slice(-16_384),
          exact_command: ["pnpm", "electron:build-main"],
        };
      }
      for (const [profileName, profile] of requestedProfiles) {
        const durationMs = scaledDuration(profile.durationMs, config.durationScale);
        const electron = config.electronControl
          ? await runElectronControl({
              batchDirectory: context.batchDirectory,
              batchID: context.batchID,
              tracePath: context.tracePath,
              fixture,
              profileName,
              profile,
              durationMs,
            })
          : { status: "skipped", reason: "disabled" };
        const hostFrames = await runNativeCase({
          binary: context.binary,
          batchID: context.batchID,
          name: `${profileName}-host-frames`,
          profile,
          durationMs,
          fixture,
          transport: "host_frames",
        });
        const backendSegment = await runNativeCase({
          binary: context.binary,
          batchID: context.batchID,
          name: `${profileName}-backend-segment`,
          profile,
          durationMs,
          fixture,
          transport: "backend_segment",
        });
        results.push({
          matrix: "baseline",
          profile: profileName,
          required: profile.required,
          duration_ms: durationMs,
          duration_scale: config.durationScale,
          electron,
          host_frames: hostFrames,
          backend_segment: backendSegment,
        });
      }
    }
    if (config.matrix.includes("lifecycle")) {
      const profile = { width: 1920, height: 1080, fps: 30 };
      const durationMs = scaledDuration(5000, config.durationScale);
      for (const scenario of [
        { name: "window-cursor-on", target: "window", cursor: true, transport: "host_frames" },
        { name: "window-cursor-off", target: "window", cursor: false, transport: "host_frames" },
        {
          name: "display-region",
          target: "display_region",
          cursor: true,
          transport: "host_frames",
        },
        { name: "display-full", target: "display", cursor: true, transport: "host_frames" },
        { name: "window-segment", target: "window", cursor: true, transport: "backend_segment" },
        {
          name: "window-audio-coexistence",
          target: "window",
          cursor: true,
          transport: "host_frames",
          audio: true,
        },
      ]) {
        results.push({
          matrix: "lifecycle",
          scenario: scenario.name,
          result: await runNativeCase({
            binary: context.binary,
            batchID: context.batchID,
            name: scenario.name,
            profile,
            durationMs,
            target: scenario.target,
            fixture,
            transport: scenario.transport,
            audio: scenario.audio ?? false,
            cursor: scenario.cursor,
            requestPermission: config.requestPermission,
          }),
        });
      }
    }
    if (config.matrix.includes("stress")) {
      const profile = { width: 2560, height: 1440, fps: 30 };
      results.push({
        matrix: "stress",
        result: await runNativeCase({
          binary: context.binary,
          batchID: context.batchID,
          name: "stress-1440p30",
          profile,
          durationMs: scaledDuration(600_000, config.durationScale),
          fixture,
          transport: "host_frames",
          requestPermission: config.requestPermission,
        }),
      });
    }
  } finally {
    await stopFixture(fixture);
  }
  return results;
}

async function systemAudioMatrix(config, context) {
  const results = [];
  const profile = { width: 1920, height: 1080, fps: 30 };
  const scenarios = [];
  if (config.matrix.includes("permissions"))
    scenarios.push({ name: "permissions", duration: 3000 });
  if (config.matrix.includes("timing")) scenarios.push({ name: "timing-10m", duration: 600_000 });
  if (config.matrix.includes("performance"))
    scenarios.push({ name: "performance-1440p30", duration: 300_000, width: 2560, height: 1440 });
  for (const scenario of scenarios) {
    results.push({
      matrix: scenario.name,
      result: await runNativeCase({
        binary: context.binary,
        batchID: context.batchID,
        name: `system-audio-${scenario.name}`,
        profile: {
          width: scenario.width ?? profile.width,
          height: scenario.height ?? profile.height,
          fps: profile.fps,
        },
        durationMs: scaledDuration(scenario.duration, config.durationScale),
        target: "display",
        transport: "host_frames",
        audio: true,
        cursor: false,
        requestPermission: config.requestPermission,
      }),
    });
  }
  return results;
}

function reportDecision(stdout) {
  const firstLine = String(stdout)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  try {
    const result = JSON.parse(firstLine ?? "");
    if (typeof result.decision === "string") return result.decision;
  } catch {
    // Normalize every report-contract failure to the same safe reason code.
  }
  const error = new Error("native spike report returned an invalid completion contract");
  error.code = "INVALID_REPORT_CONTRACT";
  throw error;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("macOS native spikes require Darwin");
  const config = parseArgs(process.argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const batchID = safeRunID(`${config.kind}-${timestamp}-${process.pid}`);
  const batchDirectory = path.join(temporaryRoot, batchID);
  await fs.mkdir(batchDirectory, { recursive: true });
  const trace = createRecordingSpikeTrace({
    batchDirectory,
    batchId: batchID,
    kind: config.kind,
    matrix: config.matrix,
    profiles: config.profiles,
    durationScale: config.durationScale,
  });
  const traceStartedAt = Date.now();
  let traceTerminal = false;
  await trace.started();
  try {
    const build = await buildHarness(batchDirectory);
    const context = {
      batchID,
      batchDirectory,
      binary: build.binary,
      build: { exact_command: build.exactCommand },
      tracePath: trace.tracePath,
      signing: await signingEvidence(build.binary),
      fixture: null,
      electron_build: null,
    };
    const results =
      config.kind === "native-capture"
        ? await nativeCaptureMatrix(config, context)
        : await systemAudioMatrix(config, context);
    const raw = {
      schema_version: 1,
      kind: config.kind,
      batch_id: batchID,
      created_at: new Date().toISOString(),
      machine: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        cpus: os.cpus().map((cpu) => cpu.model),
        total_memory_mb: os.totalmem() / 1024 / 1024,
      },
      config,
      build: context.build,
      signing: context.signing,
      fixture: context.fixture,
      electron_build: context.electron_build,
      results,
    };
    const rawPath = path.join(batchDirectory, "raw.json");
    await fs.writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const reportPath = config.output
      ? path.resolve(config.output)
      : path.join(batchDirectory, `${config.kind}-report.md`);
    const report = await run(
      process.execPath,
      [
        path.join(desktopDir, "scripts/spikes/native-capture-report.mjs"),
        "--input",
        rawPath,
        "--output",
        reportPath,
      ],
      { cwd: repoRoot },
    );
    if (report.code !== 0)
      throw new Error(`report generation failed\n${report.stderr || report.stdout}`);
    const decision = reportDecision(report.stdout);
    await trace.completed({
      decision,
      reportPath,
      durationMs: Date.now() - traceStartedAt,
    });
    traceTerminal = true;
    process.stdout.write(
      `${JSON.stringify({ status: "complete", kind: config.kind, raw_path: rawPath, report_path: reportPath })}\n`,
    );
    process.stdout.write(report.stdout);
  } catch (error) {
    if (!traceTerminal) {
      await trace.failed({
        reasonCode:
          error && typeof error === "object" && error.code === "INVALID_REPORT_CONTRACT"
            ? "spike_report_contract_invalid"
            : "spike_execution_failed",
        error,
        durationMs: Date.now() - traceStartedAt,
      });
    }
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

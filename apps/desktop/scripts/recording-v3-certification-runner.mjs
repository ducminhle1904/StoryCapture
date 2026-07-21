import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRESSURE_MODES = new Set(["none", "cpu", "disk", "cpu-disk"]);
const FIXTURE_MODES = new Set(["static", "motion"]);
const SCENARIOS = new Set(["steady", "lifecycle", "target-loss", "gpu-loss"]);

function parsePositiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${option} must be a positive integer.`);
  return parsed;
}

function parseArgs(argv, defaultDurationSeconds) {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = {
    durationSeconds: defaultDurationSeconds,
    fixture: "motion",
    pressureMode: "none",
    scenario: "steady",
    dryRun: false,
    artifactDir: path.resolve("recording-v3-certification-artifacts", `run-${Date.now()}`),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--duration-seconds") options.durationSeconds = parsePositiveInteger(value, key);
    else if (key === "--fixture") options.fixture = value;
    else if (key === "--pressure-mode") options.pressureMode = value;
    else if (key === "--scenario") options.scenario = value;
    else if (key === "--artifact-dir") options.artifactDir = path.resolve(value);
    else if (key === "--json-summary") options.jsonSummary = path.resolve(value);
    else if (key === "--capture-executable") options.captureExecutable = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  if (!FIXTURE_MODES.has(options.fixture)) throw new Error("--fixture must be static or motion.");
  if (!PRESSURE_MODES.has(options.pressureMode)) {
    throw new Error("--pressure-mode must be none, cpu, disk, or cpu-disk.");
  }
  if (!SCENARIOS.has(options.scenario)) {
    throw new Error("--scenario must be steady, lifecycle, target-loss, or gpu-loss.");
  }
  if (!options.jsonSummary)
    options.jsonSummary = path.join(options.artifactDir, "runner-summary.json");
  if (!options.dryRun && !options.captureExecutable) {
    options.captureExecutable = path.resolve(
      "release-electron",
      process.arch === "arm64" ? "mac-arm64" : "mac",
      "StoryCapture.app",
      "Contents",
      "MacOS",
      "StoryCapture",
    );
  }
  return options;
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function startPressure(options) {
  const children = [];
  if (options.pressureMode === "cpu" || options.pressureMode === "cpu-disk") {
    children.push(spawn("/usr/bin/yes", [], { stdio: ["ignore", "ignore", "ignore"] }));
  }
  if (options.pressureMode === "disk" || options.pressureMode === "cpu-disk") {
    const pressurePath = path.join(options.artifactDir, "disk-pressure.bin");
    const script = [
      'const fs = require("node:fs");',
      `const file = ${JSON.stringify(pressurePath)};`,
      "const buffer = Buffer.alloc(4 * 1024 * 1024);",
      'const handle = fs.openSync(file, "w");',
      "while (true) {",
      "  fs.writeSync(handle, buffer, 0, buffer.length, 0);",
      "  fs.fsyncSync(handle);",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
      "}",
    ].join("\n");
    children.push(
      spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "ignore"] }),
    );
  }
  return async () => {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve();
            else child.once("close", resolve);
          }),
      ),
    );
    await fs.rm(path.join(options.artifactDir, "disk-pressure.bin"), { force: true });
  };
}

async function runCapture(options, fixtureUrl, captureSummaryPath) {
  const stopPressure = startPressure(options);
  const child = spawn(
    options.captureExecutable,
    [
      "--recording-v3-certification",
      "--duration-seconds",
      String(options.durationSeconds),
      "--fixture-url",
      fixtureUrl,
      "--pressure-mode",
      options.pressureMode,
      "--scenario",
      options.scenario,
      "--artifact-dir",
      options.artifactDir,
      "--json-summary",
      captureSummaryPath,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await stopPressure();
  }
}

export async function runRecordingV3CertificationRunner({
  argv = process.argv.slice(2),
  defaultDurationSeconds,
  runnerKind,
}) {
  const options = parseArgs(argv, defaultDurationSeconds);
  await fs.mkdir(options.artifactDir, { recursive: true });
  const fixturePath = path.resolve("fixtures/recording-v3-certification/index.html");
  const fixtureUrl = `${pathToFileURL(fixturePath).href}?fixture=${options.fixture}`;
  const captureSummaryPath = path.join(options.artifactDir, "capture-summary.json");
  const startedAt = new Date().toISOString();
  let capture = { code: 0, signal: null };
  let captureSummary = null;
  if (!options.dryRun) {
    capture = await runCapture(options, fixtureUrl, captureSummaryPath);
    if (capture.code === 0) {
      captureSummary = JSON.parse(await fs.readFile(captureSummaryPath, "utf8"));
    }
  }
  const passed = options.dryRun
    ? true
    : capture.code === 0 &&
      captureSummary?.passed === true &&
      captureSummary?.duration_seconds >= options.durationSeconds &&
      captureSummary?.fixture === options.fixture &&
      captureSummary?.pressure_mode === options.pressureMode &&
      captureSummary?.scenario === options.scenario;
  const summary = {
    schema_version: 1,
    runner_kind: runnerKind,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_seconds: options.durationSeconds,
    fixture: options.fixture,
    pressure_mode: options.pressureMode,
    scenario: options.scenario,
    artifact_dir: options.artifactDir,
    dry_run: options.dryRun,
    capture_exit_code: capture.code,
    capture_signal: capture.signal,
    capture_summary_path: options.dryRun ? null : captureSummaryPath,
    passed,
  };
  await writeJsonAtomic(options.jsonSummary, summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!passed) process.exitCode = 1;
  return summary;
}

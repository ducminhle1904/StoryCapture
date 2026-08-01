#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mode = process.argv.includes("--soak") ? "soak" : "live";
const evidenceRoot = process.env.STORYCAPTURE_RECORDING_V4_EVIDENCE_DIR;
const requiredDurationSeconds = mode === "soak" ? 600 : 60;
const successScenarios =
  mode === "soak"
    ? ["ten-minute-video-only", "ten-minute-microphone-system"]
    : [
        "video-only",
        "microphone",
        "system-audio",
        "microphone-system",
        "pause-resume",
        "renderer-reload",
        "multi-dpi-display",
        "gpu-pressure",
      ];
const failureScenarios =
  mode === "soak" ? [] : ["target-loss", "helper-crash", "disk-pressure", "near-full-disk"];

function fail(message) {
  throw new Error(`Recording V4 ${mode} diagnostics failed: ${message}`);
}

function asArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function validateCompletedBundle(bundle, scenario) {
  if (
    bundle?.schema_version !== 4 ||
    bundle.profile !== "verified_1080p60" ||
    bundle.status !== "completed"
  ) {
    fail(`${scenario} did not produce a completed V4 bundle`);
  }
  if (bundle.dimensions?.physical_width !== 1920 || bundle.dimensions?.physical_height !== 1080) {
    fail(`${scenario} dimensions are not 1920x1080`);
  }
  const cadence = bundle.cadence;
  if (
    cadence?.frame_rate?.numerator !== 60 ||
    cadence.frame_rate.denominator !== 1 ||
    cadence.verdict !== "passed" ||
    cadence.output_frames !== cadence.expected_output_frames ||
    cadence.submitted_frames !== cadence.output_frames ||
    cadence.acknowledged_frames !== cadence.output_frames
  ) {
    fail(`${scenario} cadence evidence is incomplete or failed`);
  }
  if (
    !bundle.master?.encoder?.hardware_accelerated ||
    bundle.master.encoder.average_bitrate_bps <
      bundle.master.encoder.envelope.minimum_bitrate_bps ||
    bundle.master.encoder.peak_bitrate_bps > bundle.master.encoder.envelope.maximum_bitrate_bps
  ) {
    fail(`${scenario} encoder evidence is outside its calibrated envelope`);
  }
  if (
    bundle.quality?.verdict !== "passed" ||
    !bundle.artifact?.full_decode_succeeded ||
    bundle.artifact.decoded_frames !== cadence.output_frames
  ) {
    fail(`${scenario} artifact or quality evidence failed`);
  }
  for (const audio of asArray(bundle.audio, `${scenario}.audio`)) {
    if (
      audio.evidence?.status !== "captured" ||
      audio.evidence.continuity_gaps !== 0 ||
      !audio.evidence.pause_mapping_valid ||
      Math.abs(audio.evidence.end_drift_us) > audio.evidence.sync_tolerance_us
    ) {
      fail(`${scenario} ${audio.role} evidence failed continuity or synchronization`);
    }
  }
  const capturedRoles = new Set(bundle.audio.map((audio) => audio.role));
  const requiredRoles = scenario.includes("microphone-system")
    ? ["microphone", "system"]
    : scenario === "microphone"
      ? ["microphone"]
      : scenario === "system-audio"
        ? ["system"]
        : [];
  if (scenario.includes("video-only") && capturedRoles.size !== 0) {
    fail(`${scenario} unexpectedly contains audio`);
  }
  for (const role of requiredRoles) {
    if (!capturedRoles.has(role)) fail(`${scenario} is missing requested ${role} audio`);
  }
  if (scenario === "pause-resume" && cadence.pause_intervals.length === 0) {
    fail("pause-resume has no pause interval evidence");
  }
}

if (!evidenceRoot) {
  fail("set STORYCAPTURE_RECORDING_V4_EVIDENCE_DIR to the retained packaged evidence directory");
}
const matrixPath = path.join(evidenceRoot, `${process.platform}-${mode}-matrix.json`);
const matrix = await readJson(matrixPath).catch((error) => fail(`${matrixPath}: ${error.message}`));
if (
  matrix.platform !== process.platform ||
  matrix.mode !== mode ||
  matrix.package_verified !== true
) {
  fail("matrix platform, mode, or packaged evidence is invalid");
}
for (const field of ["os_version", "hardware_model", "gpu", "helper_version", "app_version"]) {
  if (typeof matrix.system?.[field] !== "string" || matrix.system[field].length === 0) {
    fail(`matrix.system.${field} is required`);
  }
}
const cases = asArray(matrix.cases, "matrix.cases");
for (const scenario of successScenarios) {
  const entry = cases.find((value) => value?.scenario === scenario);
  if (
    !entry ||
    entry.terminal_state !== "completed" ||
    entry.duration_seconds < requiredDurationSeconds
  ) {
    fail(`${scenario} is missing, incomplete, or shorter than ${requiredDurationSeconds}s`);
  }
  validateCompletedBundle(
    await readJson(path.resolve(evidenceRoot, entry.manifest_path)),
    scenario,
  );
}
for (const scenario of failureScenarios) {
  const entry = cases.find((value) => value?.scenario === scenario);
  if (
    !entry ||
    entry.terminal_state !== "failed" ||
    !Array.isArray(entry.failure_codes) ||
    entry.failure_codes.length === 0 ||
    entry.output_path !== null
  ) {
    fail(`${scenario} did not fail closed with retained evidence`);
  }
  const expectedFailure = {
    "target-loss": "target_lost",
    "helper-crash": "helper_crashed",
    "disk-pressure": "write_throughput_insufficient",
    "near-full-disk": "storage_insufficient",
  }[scenario];
  if (!entry.failure_codes.includes(expectedFailure)) {
    fail(`${scenario} is missing expected failure code ${expectedFailure}`);
  }
}
const summary = {
  schema_version: 1,
  recording_contract_version: 4,
  mode,
  platform: process.platform,
  passed_at: new Date().toISOString(),
  package_verified: true,
  required_duration_seconds: requiredDurationSeconds,
  scenarios: cases.map((entry) => entry.scenario),
  system: { release: os.release(), arch: os.arch(), cpus: os.cpus().map((cpu) => cpu.model) },
  captured_system: matrix.system,
  matrix_path: matrixPath,
};
const summaryPath = path.join(evidenceRoot, `${process.platform}-${mode}-diagnostic-summary.json`);
await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "passed", summary_path: summaryPath }));

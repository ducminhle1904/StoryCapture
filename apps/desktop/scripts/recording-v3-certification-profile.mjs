import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = { gateSummaries: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--gate-summary") options.gateSummaries.push(path.resolve(value));
    else if (key === "--signer-key-id") options.signerKeyId = value;
    else if (key === "--manifest-id") options.manifestId = value;
    else if (key === "--valid-from") options.validFrom = value;
    else if (key === "--valid-until") options.validUntil = value;
    else if (key === "--output") options.output = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
  }
  for (const key of ["signerKeyId", "manifestId", "validFrom", "validUntil", "output"]) {
    if (!options[key])
      throw new Error(`Missing --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.`);
  }
  if (options.gateSummaries.length < 4)
    throw new Error("At least four --gate-summary files are required.");
  if (
    !Number.isFinite(Date.parse(options.validFrom)) ||
    !Number.isFinite(Date.parse(options.validUntil)) ||
    Date.parse(options.validFrom) >= Date.parse(options.validUntil)
  ) {
    throw new Error("Manifest validity window is invalid.");
  }
  return options;
}

function assertGate(gates, predicate, message) {
  if (!gates.some((gate) => gate?.passed === true && predicate(gate))) throw new Error(message);
}

const RUNTIME_BINDING_KEYS = [
  "target_class",
  "platform",
  "arch",
  "hardware_model",
  "hardware_chip",
  "os_build",
  "backend_id",
  "backend_version",
  "addon_protocol_version",
  "addon_sha256",
  "electron_version",
  "chromium_version",
  "ffmpeg_version",
  "ffmpeg_sha256",
  "output_width",
  "output_height",
  "exact_fps",
  "cursor_policy",
  "audio_roles",
];

function assertExactRuntimeIdentity(identity) {
  if (
    identity?.target_class !== "browser" ||
    identity?.platform !== "darwin" ||
    identity?.arch !== "arm64" ||
    identity?.hardware_model !== "Mac17,2" ||
    identity?.hardware_chip !== "Apple M5" ||
    identity?.backend_id !== "electron_offscreen_shared_texture_v3" ||
    identity?.backend_version !== "3.0.0" ||
    identity?.addon_protocol_version !== 3 ||
    identity?.output_width !== 1920 ||
    identity?.output_height !== 1080 ||
    identity?.exact_fps?.numerator !== 60 ||
    identity?.exact_fps?.denominator !== 1 ||
    identity?.cursor_policy !== "sidecar_reconstructed" ||
    !Array.isArray(identity?.audio_roles) ||
    identity.audio_roles.length !== 0
  ) {
    throw new Error(
      "Only the exact Mac17,2 browser/video-only 1920x1080@60 profile may be generated.",
    );
  }
  for (const key of ["os_build", "electron_version", "chromium_version", "ffmpeg_version"]) {
    if (typeof identity[key] !== "string" || identity[key].length === 0) {
      throw new Error(`Certification runtime identity is missing ${key}.`);
    }
  }
  for (const key of ["addon_sha256", "ffmpeg_sha256", "evidence_artifact_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(identity[key])) {
      throw new Error(`Certification runtime identity has an invalid ${key}.`);
    }
  }
}

function sameRuntimeBinding(left, right) {
  return RUNTIME_BINDING_KEYS.every(
    (key) => JSON.stringify(left?.[key]) === JSON.stringify(right?.[key]),
  );
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

export async function generateRecordingV3CertificationProfile(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const gates = await Promise.all(
    options.gateSummaries.map((filePath) =>
      fs.readFile(filePath, "utf8").then((text) => JSON.parse(text)),
    ),
  );
  assertGate(
    gates,
    (gate) =>
      gate.duration_seconds >= 600 &&
      gate.fixture === "motion" &&
      gate.pressure_mode === "cpu-disk" &&
      gate.scenario === "lifecycle" &&
      gate.certificationQuality?.certification_verdict === "passed",
    "Missing passing 10-minute lifecycle CPU/disk soak.",
  );
  assertGate(
    gates,
    (gate) =>
      gate.duration_seconds >= 60 &&
      gate.fixture === "static" &&
      gate.certificationQuality?.certification_verdict === "passed",
    "Missing passing static fixture gate.",
  );
  assertGate(
    gates,
    (gate) => gate.scenario === "target-loss" && gate.expected_failure_observed === true,
    "Missing target-loss fail-closed cleanup gate.",
  );
  assertGate(
    gates,
    (gate) => gate.scenario === "gpu-loss" && gate.expected_failure_observed === true,
    "Missing GPU-loss fail-closed cleanup gate.",
  );
  const soak = gates.find(
    (gate) =>
      gate.duration_seconds >= 600 &&
      gate.pressure_mode === "cpu-disk" &&
      gate.scenario === "lifecycle",
  );
  const identity = soak?.runtimeIdentity;
  if (!identity || soak.certificationQuality?.certification_verdict !== "passed") {
    throw new Error("Soak summary is missing passing certification evidence and runtime identity.");
  }
  assertExactRuntimeIdentity(identity);
  const positiveGates = gates.filter(
    (gate) =>
      gate?.passed === true && gate.certificationQuality?.certification_verdict === "passed",
  );
  for (const gate of positiveGates) {
    assertExactRuntimeIdentity(gate.runtimeIdentity);
    if (!sameRuntimeBinding(identity, gate.runtimeIdentity)) {
      throw new Error("Certification gates were not produced by the same runtime binding.");
    }
  }
  const issuedAt = new Date().toISOString();
  const profile = {
    version: 3,
    profile_id: `mac17-2-m5-browser-1080p60-${identity.os_build}`,
    stage: "certified",
    target_class: identity.target_class,
    platform: identity.platform,
    arch: identity.arch,
    hardware_model: identity.hardware_model,
    hardware_chip: identity.hardware_chip,
    os_build: identity.os_build,
    backend_id: identity.backend_id,
    backend_version: identity.backend_version,
    addon_protocol_version: identity.addon_protocol_version,
    addon_sha256: identity.addon_sha256,
    electron_version: identity.electron_version,
    chromium_version: identity.chromium_version,
    ffmpeg_version: identity.ffmpeg_version,
    ffmpeg_sha256: identity.ffmpeg_sha256,
    output_width: identity.output_width,
    output_height: identity.output_height,
    exact_fps: identity.exact_fps,
    cursor_policy: identity.cursor_policy,
    audio_roles: identity.audio_roles,
    evidence_artifact_sha256: identity.evidence_artifact_sha256,
    valid_from: options.validFrom,
    valid_until: options.validUntil,
    kill_switch_id: "recording-v3-mac17-2-browser-1080p60",
  };
  const payload = {
    schema_version: 1,
    manifest_id: options.manifestId,
    canonicalization: "RFC8785",
    signature_algorithm: "ed25519",
    signer_key_id: options.signerKeyId,
    issued_at: issuedAt,
    valid_from: options.validFrom,
    valid_until: options.validUntil,
    disabled_kill_switch_ids: [],
    profiles: [profile],
  };
  await writeJsonAtomic(options.output, payload);
  process.stdout.write(
    `${JSON.stringify({ manifest_id: payload.manifest_id, profile_id: profile.profile_id, output: options.output })}\n`,
  );
  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateRecordingV3CertificationProfile().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

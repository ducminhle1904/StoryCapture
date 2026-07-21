import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    if (key === "--app-path") options.appPath = path.resolve(value);
    else if (key === "--expected-team-id") options.expectedTeamId = value;
    else if (key === "--public-key") options.publicKey = path.resolve(value);
    else if (key === "--runtime-summary") options.runtimeSummary = path.resolve(value);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (
    !options.appPath ||
    !options.expectedTeamId ||
    !options.publicKey ||
    !options.runtimeSummary
  ) {
    throw new Error(
      "--app-path, --expected-team-id, --public-key, and --runtime-summary are required.",
    );
  }
  return options;
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function canonicalize(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers.");
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (typeof value !== "object" || seen.has(value)) throw new TypeError("Invalid canonical JSON.");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

export async function verifyRecordingV3Release(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const resources = path.join(options.appPath, "Contents", "Resources");
  const addonPath = path.join(resources, "native", "macos", "storycapture_recording_v3.node");
  const manifestPath = path.join(resources, "recording-v3-certification", "manifest.json");
  const evidencePath = path.join(resources, "recording-v3-certification", "evidence.json");
  const executablePath = path.join(options.appPath, "Contents", "MacOS", "StoryCapture");
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", options.appPath]);
  for (const signedPath of [options.appPath, addonPath]) {
    const detail = command("/usr/bin/codesign", ["--display", "--verbose=4", signedPath]);
    if (!detail.includes(`TeamIdentifier=${options.expectedTeamId}`)) {
      throw new Error(`${signedPath} is not signed by expected team ${options.expectedTeamId}.`);
    }
    if (!detail.includes("runtime")) throw new Error(`${signedPath} lacks hardened runtime.`);
  }
  command("/usr/bin/xcrun", ["stapler", "validate", options.appPath]);
  const assessment = command("/usr/sbin/spctl", ["-a", "-vv", "-t", "exec", options.appPath]);
  if (!/accepted/i.test(assessment) || !/Notarized Developer ID/i.test(assessment)) {
    throw new Error("Gatekeeper did not report a notarized Developer ID application.");
  }

  const [signedManifest, runtimeSummary, publicPem] = await Promise.all([
    fs.readFile(manifestPath, "utf8").then(JSON.parse),
    fs.readFile(options.runtimeSummary, "utf8").then(JSON.parse),
    fs.readFile(options.publicKey, "utf8"),
  ]);
  const publicKey = createPublicKey(publicPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 public key.");
  const signatureValid = verify(
    null,
    Buffer.from(canonicalize(signedManifest.payload)),
    publicKey,
    Buffer.from(signedManifest.signature, "base64"),
  );
  if (!signatureValid) throw new Error("Recording V3 manifest signature is invalid.");
  if (signedManifest.payload.profiles?.length !== 1) {
    throw new Error("Release manifest must contain exactly one certified profile.");
  }
  const profile = signedManifest.payload.profiles[0];
  if (
    profile.stage !== "certified" ||
    profile.target_class !== "browser" ||
    profile.hardware_model !== "Mac17,2" ||
    profile.hardware_chip !== "Apple M5" ||
    profile.output_width !== 1920 ||
    profile.output_height !== 1080 ||
    profile.exact_fps?.numerator !== 60 ||
    profile.exact_fps?.denominator !== 1 ||
    profile.audio_roles?.length !== 0 ||
    profile.cursor_policy !== "sidecar_reconstructed"
  ) {
    throw new Error(
      "Release manifest profile exceeds the approved Mac17,2 browser/video-only scope.",
    );
  }
  const runtimeIdentity = runtimeSummary.runtimeIdentity;
  for (const [key, value] of Object.entries(runtimeIdentity)) {
    if (profile[key] !== value) throw new Error(`Profile/runtime mismatch at ${key}.`);
  }
  if ((await sha256File(addonPath)) !== profile.addon_sha256) {
    throw new Error("Packaged addon hash does not match the profile.");
  }
  if ((await sha256File(evidencePath)) !== profile.evidence_artifact_sha256) {
    throw new Error("Packaged evidence hash does not match the profile.");
  }
  const cleanLaunchPath = path.join(
    path.dirname(options.runtimeSummary),
    "clean-packaged-launch.json",
  );
  await fs.rm(cleanLaunchPath, { force: true });
  command(executablePath, [`--storycapture-recording-v3-release-smoke-result=${cleanLaunchPath}`], {
    timeout: 120_000,
  });
  const cleanLaunch = JSON.parse(await fs.readFile(cleanLaunchPath, "utf8"));
  if (
    cleanLaunch.passed !== true ||
    cleanLaunch.preflight?.strict_eligible !== true ||
    cleanLaunch.preflight?.failure_codes?.length !== 0 ||
    cleanLaunch.preflight?.manifest_id !== signedManifest.payload.manifest_id ||
    cleanLaunch.preflight?.matched_profile?.profile_id !== profile.profile_id
  ) {
    throw new Error("Clean packaged launch did not enable the single certified profile.");
  }
  process.stdout.write(
    `${JSON.stringify({ passed: true, manifest_id: signedManifest.payload.manifest_id, profile_id: profile.profile_id })}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyRecordingV3Release().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

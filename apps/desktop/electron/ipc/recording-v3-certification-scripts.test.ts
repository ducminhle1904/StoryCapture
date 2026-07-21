import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { verifyRecordingCertificationManifestV3 } from "./recording-v3-certification-manifest";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-certification-"));
  tempDirectories.push(directory);
  return directory;
}

function certificationRuntimeIdentity(overrides: Record<string, unknown> = {}) {
  return {
    target_class: "browser",
    platform: "darwin",
    arch: "arm64",
    hardware_model: "Mac17,2",
    hardware_chip: "Apple M5",
    os_build: "25F84",
    backend_id: "electron_offscreen_shared_texture_v3",
    backend_version: "3.0.0",
    addon_protocol_version: 3,
    addon_sha256: "a".repeat(64),
    electron_version: "42.4.1",
    chromium_version: "142.0.7444.175",
    ffmpeg_version: "ffmpeg version 7.1",
    ffmpeg_sha256: "b".repeat(64),
    output_width: 1920,
    output_height: 1080,
    exact_fps: { numerator: 60, denominator: 1 },
    cursor_policy: "sidecar_reconstructed",
    audio_roles: [],
    evidence_artifact_sha256: "c".repeat(64),
    ...overrides,
  };
}

async function writeCertificationGateSummaries(
  directory: string,
  staticIdentity = certificationRuntimeIdentity({ evidence_artifact_sha256: "d".repeat(64) }),
): Promise<string[]> {
  const summaries = [
    {
      passed: true,
      duration_seconds: 600,
      fixture: "motion",
      pressure_mode: "cpu-disk",
      scenario: "lifecycle",
      certificationQuality: { certification_verdict: "passed" },
      runtimeIdentity: certificationRuntimeIdentity(),
    },
    {
      passed: true,
      duration_seconds: 60,
      fixture: "static",
      pressure_mode: "none",
      scenario: "steady",
      certificationQuality: { certification_verdict: "passed" },
      runtimeIdentity: staticIdentity,
    },
    {
      passed: true,
      duration_seconds: 2,
      fixture: "motion",
      pressure_mode: "none",
      scenario: "target-loss",
      expected_failure_observed: true,
    },
    {
      passed: true,
      duration_seconds: 2,
      fixture: "motion",
      pressure_mode: "none",
      scenario: "gpu-loss",
      expected_failure_observed: true,
    },
  ];
  return Promise.all(
    summaries.map(async (summary, index) => {
      const filePath = path.join(directory, `gate-${index}.json`);
      await fs.writeFile(filePath, JSON.stringify(summary));
      return filePath;
    }),
  );
}

describe("recording V3 certification manifest signing CLI", () => {
  it("signs canonical payloads without leaking private key material", async () => {
    const directory = await temporaryDirectory();
    const payloadPath = path.join(directory, "payload.json");
    const privateKeyPath = path.join(directory, "release-private.pem");
    const outputPath = path.join(directory, "signed-manifest.json");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await fs.writeFile(privateKeyPath, privatePem, { mode: 0o600 });
    await fs.writeFile(
      payloadPath,
      JSON.stringify({
        schema_version: 1,
        manifest_id: "fixture-manifest",
        canonicalization: "RFC8785",
        signature_algorithm: "ed25519",
        signer_key_id: "fixture-key",
        issued_at: "2026-07-21T00:00:00.000Z",
        valid_from: "2026-07-21T00:00:00.000Z",
        valid_until: "2026-08-21T00:00:00.000Z",
        disabled_kill_switch_ids: [],
        profiles: [],
      }),
    );

    const result = await execFileAsync(
      process.execPath,
      [
        "scripts/recording-v3-certification-sign-manifest.mjs",
        "--",
        "--payload",
        payloadPath,
        "--private-key",
        privateKeyPath,
        "--output",
        outputPath,
      ],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    const signed = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(
      verifyRecordingCertificationManifestV3(
        signed,
        { "fixture-key": publicKey },
        Date.parse("2026-07-22T00:00:00.000Z"),
      ).failure_codes,
    ).toEqual([]);
    expect(result.stdout).not.toContain("PRIVATE KEY");
    expect(result.stderr).not.toContain("PRIVATE KEY");
    expect(await fs.readFile(outputPath, "utf8")).not.toContain("PRIVATE KEY");
  });
});

describe("recording V3 sustained runner commands", () => {
  it.each([
    ["recording-v3-certification-60s.mjs", 60, "nightly-60-second"],
    ["recording-v3-certification-10m.mjs", 600, "protected-release-10-minute"],
  ])("prepares %s with deterministic options and a JSON summary", async (script, duration, kind) => {
    const directory = await temporaryDirectory();
    const summaryPath = path.join(directory, "summary.json");
    const result = await execFileAsync(
      process.execPath,
      [
        `scripts/${script}`,
        "--",
        "--dry-run",
        "--fixture",
        "static",
        "--pressure-mode",
        "cpu-disk",
        "--artifact-dir",
        directory,
        "--json-summary",
        summaryPath,
      ],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    expect(summary).toMatchObject({
      runner_kind: kind,
      duration_seconds: duration,
      fixture: "static",
      pressure_mode: "cpu-disk",
      scenario: "steady",
      dry_run: true,
      passed: true,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ duration_seconds: duration, passed: true });
  });
});

describe("recording V3 protected profile generation", () => {
  it("generates exactly one certified profile from bound passing gates", async () => {
    const directory = await temporaryDirectory();
    const gatePaths = await writeCertificationGateSummaries(directory);
    const outputPath = path.join(directory, "payload.json");
    const args = gatePaths.flatMap((gatePath) => ["--gate-summary", gatePath]);
    await execFileAsync(
      process.execPath,
      [
        "scripts/recording-v3-certification-profile.mjs",
        ...args,
        "--signer-key-id",
        "release-key",
        "--manifest-id",
        "release-manifest",
        "--valid-from",
        "2026-07-21T00:00:00.000Z",
        "--valid-until",
        "2026-08-21T00:00:00.000Z",
        "--output",
        outputPath,
      ],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    const payload = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]).toMatchObject({
      stage: "certified",
      target_class: "browser",
      hardware_model: "Mac17,2",
      hardware_chip: "Apple M5",
      output_width: 1920,
      output_height: 1080,
      audio_roles: [],
    });
  });

  it("rejects gates produced by a different runtime binding", async () => {
    const directory = await temporaryDirectory();
    const gatePaths = await writeCertificationGateSummaries(
      directory,
      certificationRuntimeIdentity({
        addon_sha256: "e".repeat(64),
        evidence_artifact_sha256: "d".repeat(64),
      }),
    );
    const args = gatePaths.flatMap((gatePath) => ["--gate-summary", gatePath]);
    await expect(
      execFileAsync(
        process.execPath,
        [
          "scripts/recording-v3-certification-profile.mjs",
          ...args,
          "--signer-key-id",
          "release-key",
          "--manifest-id",
          "release-manifest",
          "--valid-from",
          "2026-07-21T00:00:00.000Z",
          "--valid-until",
          "2026-08-21T00:00:00.000Z",
          "--output",
          path.join(directory, "payload.json"),
        ],
        { cwd: path.resolve("."), encoding: "utf8" },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("same runtime binding") });
  });
});

describe("recording V3 protected signer injection", () => {
  it("injects only an Ed25519 public key into generated source", async () => {
    const directory = await temporaryDirectory();
    const publicKeyPath = path.join(directory, "public.pem");
    const outputPath = path.join(directory, "signers.generated.ts");
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await fs.writeFile(publicKeyPath, publicPem);
    await execFileAsync(
      process.execPath,
      [
        "scripts/recording-v3-certification-inject-signer.mjs",
        "--signer-key-id",
        "release-key",
        "--public-key",
        publicKeyPath,
        "--output",
        outputPath,
      ],
      { cwd: path.resolve("."), encoding: "utf8" },
    );
    const generated = await fs.readFile(outputPath, "utf8");
    expect(generated).toContain('"release-key"');
    expect(generated).toContain("BEGIN PUBLIC KEY");
    expect(generated).not.toContain("PRIVATE KEY");
  });
});

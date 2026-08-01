import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(desktopRoot, "../..");

let macVerifier = "";
let diagnostics = "";
let workflow = "";
let packageScripts: Record<string, string> = {};

beforeAll(async () => {
  const [verifierSource, diagnosticsSource, workflowSource, packageSource] = await Promise.all([
    fs.readFile(
      path.join(desktopRoot, "native/macos-screen-capture/verify-packaged-helper.mjs"),
      "utf8",
    ),
    fs.readFile(path.join(desktopRoot, "scripts/recording-v4-diagnostics.mjs"), "utf8"),
    fs.readFile(path.join(repoRoot, ".github/workflows/recording-v4-diagnostics.yml"), "utf8"),
    fs.readFile(path.join(desktopRoot, "package.json"), "utf8"),
  ]);
  macVerifier = verifierSource;
  diagnostics = diagnosticsSource;
  workflow = workflowSource;
  packageScripts = JSON.parse(packageSource).scripts ?? {};
});

describe("Recording V4 diagnostics policy", () => {
  it("runs live and soak evidence checks as nonblocking diagnostics", () => {
    expect(workflow).toContain("name: Recording V4 diagnostics");
    expect(workflow.match(/continue-on-error: true/g)).toHaveLength(2);
    expect(workflow).toContain("diagnose:recording-v4-live");
    expect(workflow).toContain("diagnose:recording-v4-soak");
  });

  it("runs both diagnostics through the packaged V4 helper smoke", () => {
    expect(packageScripts["diagnose:recording-v4-live"]).toBe(
      "pnpm test:e2e:recording-v4-helper && node scripts/recording-v4-diagnostics.mjs --live",
    );
    expect(packageScripts["diagnose:recording-v4-soak"]).toBe(
      "pnpm test:e2e:recording-v4-helper && node scripts/recording-v4-diagnostics.mjs --soak",
    );
  });

  it("does not require an Apple Developer ID for macOS packaged diagnostics", () => {
    expect(macVerifier).toContain('codesign", ["--verify", "--strict"');
    expect(macVerifier).not.toContain("Developer ID Application");
    expect(macVerifier).not.toContain("APPLE_TEAM_ID");
    expect(macVerifier).not.toContain("STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS");

    const macJob = workflow.slice(workflow.indexOf("  macos:"), workflow.indexOf("  windows:"));
    expect(macJob).toContain("macOS packaged capture diagnostics");
    expect(macJob).not.toContain("STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS");
  });

  it("uses package verification evidence while retaining Windows signing diagnostics", () => {
    expect(diagnostics).toContain("matrix.package_verified !== true");
    expect(diagnostics).toContain("package_verified: true");
    expect(diagnostics).not.toContain("package_signed");

    const windowsJob = workflow.slice(workflow.indexOf("  windows:"));
    expect(windowsJob).toContain('STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS: "1"');
    expect(windowsJob).toContain("Windows signed capture diagnostics");
  });
});

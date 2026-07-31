import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(desktopRoot, "../..");

let macVerifier = "";
let certification = "";
let workflow = "";

beforeAll(async () => {
  [macVerifier, certification, workflow] = await Promise.all([
    fs.readFile(
      path.join(desktopRoot, "native/macos-screen-capture/verify-packaged-helper.mjs"),
      "utf8",
    ),
    fs.readFile(path.join(desktopRoot, "scripts/recording-v4-certification.mjs"), "utf8"),
    fs.readFile(path.join(repoRoot, ".github/workflows/recording-v4-certification.yml"), "utf8"),
  ]);
});

describe("Recording V4 certification policy", () => {
  it("does not require an Apple Developer ID for the macOS packaged gate", () => {
    expect(macVerifier).toContain('codesign", ["--verify", "--strict"');
    expect(macVerifier).not.toContain("Developer ID Application");
    expect(macVerifier).not.toContain("APPLE_TEAM_ID");
    expect(macVerifier).not.toContain("STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS");

    const macJob = workflow.slice(workflow.indexOf("  macos:"), workflow.indexOf("  windows:"));
    expect(macJob).toContain("macOS packaged live capture");
    expect(macJob).not.toContain("STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS");
  });

  it("uses package verification evidence while retaining the Windows signing gate", () => {
    expect(certification).toContain("matrix.package_verified !== true");
    expect(certification).toContain("package_verified: true");
    expect(certification).not.toContain("package_signed");

    const windowsJob = workflow.slice(workflow.indexOf("  windows:"));
    expect(windowsJob).toContain('STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS: "1"');
    expect(windowsJob).toContain("Windows signed live capture");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../native/windows-capture",
);
let nativeSource = "";
let cmake = "";
let manifest = "";
let buildScript = "";
let packageVerifier = "";
let nativeBuildOrchestrator = "";
let desktopPackage: {
  scripts?: Record<string, string>;
  build?: { win?: { extraResources?: Array<{ from?: string; to?: string }> } };
} = {};

beforeAll(async () => {
  const sources = await Promise.all(
    [
      "src/main.cpp",
      "src/capture_session.cpp",
      "src/capture_session.hpp",
      "src/frame_ring.cpp",
      "src/frame_ring.hpp",
      "src/target_resolver.cpp",
      "src/target_resolver.hpp",
      "src/protocol.hpp",
    ].map((relativePath) => fs.readFile(path.join(root, relativePath), "utf8")),
  );
  nativeSource = sources.join("\n");
  [cmake, manifest, buildScript, packageVerifier] = await Promise.all(
    ["CMakeLists.txt", "helper.manifest", "build.ps1", "verify-package.ps1"].map((relativePath) =>
      fs.readFile(path.join(root, relativePath), "utf8"),
    ),
  );
  const desktopRoot = path.resolve(root, "../..");
  const [packageText, orchestratorText] = await Promise.all([
    fs.readFile(path.join(desktopRoot, "package.json"), "utf8"),
    fs.readFile(path.join(desktopRoot, "scripts/build-native-capture.mjs"), "utf8"),
  ]);
  desktopPackage = JSON.parse(packageText) as typeof desktopPackage;
  nativeBuildOrchestrator = orchestratorText;
});

describe("packaged Windows Graphics Capture helper", () => {
  it("uses C++/WinRT WGC, the target adapter, D3D BGRA, and an eight-slot shared ring", () => {
    expect(nativeSource).toContain("Windows::Graphics::Capture::Direct3D11CaptureFramePool");
    expect(nativeSource).toContain("CreateFreeThreaded");
    expect(nativeSource).toContain("B8G8R8A8UIntNormalized");
    expect(nativeSource).toContain("adapter_for_target");
    expect(nativeSource).toContain("EnumOutputs");
    expect(nativeSource).toContain("CreateFileMappingW");
    expect(nativeSource).toContain("k_ring_capacity = 8");
    expect(nativeSource).toContain("InterlockedCompareExchange");
    expect(nativeSource).toContain("D3D11_USAGE_STAGING");
    expect(nativeSource).toContain("frame_ring_overflow");
  });

  it("uses deterministic target identity and fails closed on resize, removal, occlusion stalls, and sleep", () => {
    expect(nativeSource).toContain("CreateForMonitor");
    expect(nativeSource).toContain("CreateForWindow");
    expect(nativeSource).toContain("QueryFullProcessImageNameW");
    expect(nativeSource).toContain("GetClassNameW");
    expect(nativeSource).toContain("target_ambiguous");
    expect(nativeSource).toContain("target_identity_matches");
    expect(nativeSource).toContain("item.Closed");
    expect(nativeSource).toContain("format-changed");
    expect(nativeSource).toContain("source_rate_mismatch");
    expect(nativeSource).toContain("qpc_us() - last_frame_qpc_us > 2'000'000");
    expect(nativeSource).toContain("std::scoped_lock lock(mutex_)");
    expect(nativeSource).toContain("paused_.store(false)");
    expect(nativeSource).not.toContain("IsIconic(");
    expect(nativeSource).not.toContain("IsWindowVisible(");
  });

  it("uses source-native monotonic time, pause exclusion, cursor policy, and an audio clock anchor", () => {
    expect(nativeSource).toContain("SystemRelativeTime");
    expect(nativeSource).toContain("QueryPerformanceCounter");
    expect(nativeSource).toContain("paused_duration_us_");
    expect(nativeSource).toContain("IsCursorCaptureEnabled");
    expect(nativeSource).toContain('L"clock-anchor"');
    expect(nativeSource).toContain("48'000");
  });

  it("contains no thumbnail polling, encoded still frames, JS bitmap path, stale cache, or timer fallback", () => {
    const forbidden = [
      "desktopCapturer",
      "getSources",
      "capturePage",
      "thumbnail",
      "toDataURL",
      "latestImage",
      "setInterval",
      ".png",
    ];
    for (const token of forbidden) expect(nativeSource).not.toContain(token);
  });

  it("builds a per-monitor-DPI helper and requires Authenticode signing and package verification", () => {
    expect(cmake).toContain("windowsapp");
    expect(cmake).toContain("/W4 /WX");
    expect(manifest).toContain("PerMonitorV2");
    expect(manifest).toContain('level="asInvoker"');
    expect(buildScript).toContain("STORYCAPTURE_WINDOWS_CERT_THUMBPRINT");
    expect(buildScript).toContain("signtool.exe");
    expect(buildScript).toContain("sign /sha1");
    expect(buildScript).toContain("verify /pa /all");
    expect(packageVerifier).toContain("Get-AuthenticodeSignature");
    expect(packageVerifier).toContain("windows-graphics-capture");
    expect(desktopPackage.scripts?.["native:build"]).toBe("node scripts/build-native-capture.mjs");
    expect(nativeBuildOrchestrator).toContain("STORYCAPTURE_REQUIRE_SIGNED_NATIVE_HELPERS");
    expect(nativeBuildOrchestrator).toContain("STORYCAPTURE_WINDOWS_CERT_THUMBPRINT");
    expect(nativeBuildOrchestrator).toContain('args.push("-Sign")');
    const archMacro = "$" + "{arch}";
    expect(desktopPackage.build?.win?.extraResources).toEqual(
      expect.arrayContaining([
        {
          from: `native/windows-capture/bin/${archMacro}/storycapture-wgc.exe`,
          to: `native/windows/${archMacro}/storycapture-wgc.exe`,
        },
      ]),
    );
  });
});

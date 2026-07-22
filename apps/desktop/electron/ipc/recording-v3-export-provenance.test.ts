import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertRecordingV3UploadAllowed,
  initializeRecordingV3ExportProvenance,
  recordingV3ModeForExportGraph,
  recordingV3ModeForUploadPath,
  recordingV3ModeFromExportGraph,
  registerRecordingV3Export,
  registerStrictLocalExport,
  STRICT_CERTIFIED_UPLOAD_ERROR,
  STRICT_LOCAL_UPLOAD_ERROR,
  suffixStrictLocalBaseName,
} from "./recording-v3-export-provenance";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-provenance-"));
  temporaryRoots.push(root);
  return root;
}

type GraphMode =
  | "strict_local"
  | "strict_certified"
  | "uncertified_development"
  | "certified";

function graph(recordingMode: GraphMode): string {
  const certified = recordingMode === "strict_certified" || recordingMode === "certified";
  return JSON.stringify({
    video: [
      {
        type: "source",
        recording_source: {
          version: 3,
          bundle_path: "/tmp/take.sc-recording",
          master_path: "/tmp/take.sc-recording/master/video.mkv",
          proxy_path: "/tmp/take.sc-recording/proxy/video.mp4",
          cadence_evidence_path: "/tmp/take.sc-recording/evidence/cadence.json",
          quality_evidence_path: "/tmp/take.sc-recording/evidence/runtime-quality.json",
          frame_ledger_path: "/tmp/take.sc-recording/evidence/frame-ledger.jsonl",
          exact_source_fps: { numerator: 60, denominator: 1 },
          source_frame_count: 60,
          master_width: 1920,
          master_height: 1080,
          quality_verdict: "passed",
          guarantee_boundary: "electron_offscreen_delivery",
          source_scope_verified: true,
          recording_mode: recordingMode,
          certification_profile_id: certified ? "mac17-2-v3" : null,
        },
      },
    ],
  });
}

function bundleManifest(recordingMode: GraphMode) {
  const local =
    recordingMode === "strict_local" || recordingMode === "uncertified_development";
  const legacy = recordingMode === "uncertified_development" || recordingMode === "certified";
  const hash = "a".repeat(64);
  return {
    schema_version: 3,
    status: "completed",
    created_at: new Date(0).toISOString(),
    delivery_policy: legacy && local ? "development" : "strict",
    recording_mode: recordingMode,
    certification_profile: local
      ? null
      : {
          manifest_id: "manifest-2026-07",
          profile_id: "mac17-2-v3",
          evidence_artifact_sha256: hash,
        },
    capture_contract: {
      version: 3,
      guarantee_boundary: "electron_offscreen_delivery",
      source_ordinal_kind: "electron_frame_count",
      target_class: "browser",
      exact_fps: { numerator: 60, denominator: 1 },
      dimensions: {
        logical_width: 960,
        logical_height: 540,
        capture_dpr: local ? 1 : 2,
        physical_width: local ? 960 : 1920,
        physical_height: local ? 540 : 1080,
        requested_output_width: local ? 960 : 1920,
        requested_output_height: local ? 540 : 1080,
      },
      cursor_policy: "sidecar_reconstructed",
      audio_roles: [],
    },
    master: {
      relative_path: "master/video.mkv",
      bytes: 100,
      sha256: hash,
      codec: "ffv1",
      pixel_format: "bgra",
      frame_count: 60,
      exact_fps: { numerator: 60, denominator: 1 },
    },
    proxy: {
      relative_path: "proxy/video.mp4",
      bytes: 5,
      sha256: hash,
      codec: "h264",
    },
    audio: [],
    evidence: {
      cadence_path: "evidence/cadence.json",
      runtime_quality_path: "evidence/runtime-quality.json",
      certification_quality_path: local ? null : "evidence/certification-quality.json",
    },
    sidecars: { actions_path: null, cursor_path: null },
    frame_ledger_path: "evidence/frame-ledger.jsonl",
    diagnostics_manifest_path: "diagnostics/manifest.json",
    failure_codes: [],
  };
}

async function createBundle(root: string, recordingMode: GraphMode) {
  const bundle = path.join(root, `${recordingMode}.sc-recording`);
  const proxy = path.join(bundle, "proxy/video.mp4");
  await fs.mkdir(path.dirname(proxy), { recursive: true });
  await fs.writeFile(proxy, "video");
  const manifestPath = path.join(bundle, "manifest.json");
  const manifestText = JSON.stringify(bundleManifest(recordingMode));
  await fs.writeFile(manifestPath, manifestText);
  return { manifestPath, manifestText, proxy };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("Recording V3 export provenance", () => {
  it.each([
    ["strict_local", "strict_local"],
    ["uncertified_development", "strict_local"],
    ["strict_certified", "strict_certified"],
    ["certified", "strict_certified"],
  ] as const)("normalizes graph mode %s to %s", (input, expected) => {
    expect(recordingV3ModeFromExportGraph(graph(input))).toBe(expected);
  });

  it("adds the Strict Local suffix exactly once", () => {
    expect(suffixStrictLocalBaseName("demo")).toBe("demo-strict-local");
    expect(suffixStrictLocalBaseName("demo-strict-local")).toBe("demo-strict-local");
  });

  it("persists canonical Strict Local export provenance across registry reinitialization", async () => {
    const root = await temporaryRoot();
    const output = path.join(root, "demo-strict-local.mp4");
    await fs.writeFile(output, "video");
    initializeRecordingV3ExportProvenance(root);
    await registerStrictLocalExport(output);

    initializeRecordingV3ExportProvenance(root);

    await expect(recordingV3ModeForUploadPath(output)).resolves.toBe("strict_local");
    await expect(assertRecordingV3UploadAllowed(output, "strict_certified")).rejects.toThrow(
      STRICT_LOCAL_UPLOAD_ERROR,
    );
  });

  it("persists verified Strict Certified export provenance across registry reinitialization", async () => {
    const root = await temporaryRoot();
    const output = path.join(root, "demo.mp4");
    await fs.writeFile(output, "video");
    initializeRecordingV3ExportProvenance(root);
    await registerRecordingV3Export(output, "strict_certified");

    initializeRecordingV3ExportProvenance(root);

    await expect(recordingV3ModeForUploadPath(output)).resolves.toBe("strict_certified");
    await expect(assertRecordingV3UploadAllowed(output, "strict_certified")).resolves.toBeUndefined();
  });

  it.each([
    ["uncertified_development", "strict_local", false],
    ["strict_local", "strict_local", false],
    ["certified", "strict_certified", true],
    ["strict_certified", "strict_certified", true],
  ] as const)(
    "applies certification-based upload admission for %s without rewriting its manifest",
    async (inputMode, normalizedMode, allowed) => {
      const root = await temporaryRoot();
      const { manifestPath, manifestText, proxy } = await createBundle(root, inputMode);
      initializeRecordingV3ExportProvenance(root);

      await expect(recordingV3ModeForUploadPath(proxy)).resolves.toBe(normalizedMode);
      if (allowed) {
        await expect(assertRecordingV3UploadAllowed(proxy, inputMode)).resolves.toBeUndefined();
      } else {
        await expect(assertRecordingV3UploadAllowed(proxy, inputMode)).rejects.toThrow(
          STRICT_LOCAL_UPLOAD_ERROR,
        );
      }
      await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe(manifestText);
    },
  );

  it("uses validated bundle provenance over forged graph metadata", async () => {
    const root = await temporaryRoot();
    const { proxy } = await createBundle(root, "uncertified_development");
    initializeRecordingV3ExportProvenance(root);

    const sourceWithoutMetadata = JSON.stringify({ video: [{ type: "source", path: proxy }] });
    const certifiedSource = (JSON.parse(graph("strict_certified")) as { video: unknown[] })
      .video[0];
    const sourceWithForgedMetadata = JSON.stringify({
      video: [{ ...(certifiedSource as object), path: proxy }],
    });
    await expect(recordingV3ModeForExportGraph(sourceWithoutMetadata)).resolves.toBe(
      "strict_local",
    );
    await expect(recordingV3ModeForExportGraph(sourceWithForgedMetadata)).resolves.toBe(
      "strict_local",
    );
  });

  it("rejects a Strict Certified graph claim without verified path provenance", async () => {
    const root = await temporaryRoot();
    const sourcePath = path.join(root, "ordinary.mp4");
    await fs.writeFile(sourcePath, "video");
    initializeRecordingV3ExportProvenance(root);
    const certifiedSource = (JSON.parse(graph("strict_certified")) as { video: unknown[] })
      .video[0];
    const forgedGraph = JSON.stringify({
      video: [{ ...(certifiedSource as object), path: sourcePath }],
    });

    await expect(recordingV3ModeForExportGraph(forgedGraph)).rejects.toThrow(
      STRICT_CERTIFIED_UPLOAD_ERROR,
    );
    await expect(assertRecordingV3UploadAllowed(sourcePath, "strict_certified")).rejects.toThrow(
      STRICT_CERTIFIED_UPLOAD_ERROR,
    );
  });

  it("rejects a quality-failed Strict Certified bundle", async () => {
    const root = await temporaryRoot();
    const { manifestPath, proxy } = await createBundle(root, "strict_certified");
    const failedManifest = {
      ...bundleManifest("strict_certified"),
      status: "quality_failed",
      certification_profile: null,
      failure_codes: ["runtime_integrity_failed"],
    };
    await fs.writeFile(manifestPath, JSON.stringify(failedManifest));
    initializeRecordingV3ExportProvenance(root);

    await expect(assertRecordingV3UploadAllowed(proxy, "strict_certified")).rejects.toThrow(
      STRICT_CERTIFIED_UPLOAD_ERROR,
    );
  });

  it("rejects explicit Strict Local provenance before touching the file system", async () => {
    await expect(
      assertRecordingV3UploadAllowed("/missing/video.mp4", "uncertified_development"),
    ).rejects.toThrow(STRICT_LOCAL_UPLOAD_ERROR);
  });
});

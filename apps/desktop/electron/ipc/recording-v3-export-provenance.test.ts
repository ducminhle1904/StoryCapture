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
  registerUncertifiedDevelopmentExport,
  suffixUncertifiedDevelopmentBaseName,
  UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR,
} from "./recording-v3-export-provenance";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-provenance-"));
  temporaryRoots.push(root);
  return root;
}

function graph(recordingMode: "certified" | "uncertified_development"): string {
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
          certification_profile_id: recordingMode === "certified" ? "mac17-2-v3" : null,
        },
      },
    ],
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("Recording V3 export provenance", () => {
  it("derives certified and uncertified modes from validated graph source metadata", () => {
    expect(recordingV3ModeFromExportGraph(graph("certified"))).toBe("certified");
    expect(recordingV3ModeFromExportGraph(graph("uncertified_development"))).toBe(
      "uncertified_development",
    );
  });

  it("adds the uncertified suffix exactly once", () => {
    expect(suffixUncertifiedDevelopmentBaseName("demo")).toBe("demo-uncertified-dev");
    expect(suffixUncertifiedDevelopmentBaseName("demo-uncertified-dev")).toBe(
      "demo-uncertified-dev",
    );
  });

  it("persists canonical export provenance across registry reinitialization", async () => {
    const root = await temporaryRoot();
    const output = path.join(root, "demo-uncertified-dev.mp4");
    await fs.writeFile(output, "video");
    initializeRecordingV3ExportProvenance(root);
    await registerUncertifiedDevelopmentExport(output);

    initializeRecordingV3ExportProvenance(root);

    await expect(recordingV3ModeForUploadPath(output)).resolves.toBe(
      "uncertified_development",
    );
    await expect(assertRecordingV3UploadAllowed(output, "certified")).rejects.toThrow(
      UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR,
    );
  });

  it("rejects a development bundle proxy from validated manifest provenance", async () => {
    const root = await temporaryRoot();
    const bundle = path.join(root, "take-uncertified-dev.sc-recording");
    const proxy = path.join(bundle, "proxy/video.mp4");
    await fs.mkdir(path.dirname(proxy), { recursive: true });
    await fs.writeFile(proxy, "video");
    const hash = "a".repeat(64);
    await fs.writeFile(
      path.join(bundle, "manifest.json"),
      JSON.stringify({
        schema_version: 3,
        status: "completed",
        created_at: new Date(0).toISOString(),
        delivery_policy: "development",
        recording_mode: "uncertified_development",
        certification_profile: null,
        capture_contract: {
          version: 3,
          guarantee_boundary: "electron_offscreen_delivery",
          source_ordinal_kind: "electron_frame_count",
          target_class: "browser",
          exact_fps: { numerator: 60, denominator: 1 },
          dimensions: {
            logical_width: 960,
            logical_height: 540,
            capture_dpr: 2,
            physical_width: 1920,
            physical_height: 1080,
            requested_output_width: 1920,
            requested_output_height: 1080,
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
          certification_quality_path: null,
        },
        sidecars: { actions_path: null, cursor_path: null },
        frame_ledger_path: "evidence/frame-ledger.jsonl",
        diagnostics_manifest_path: "diagnostics/manifest.json",
        failure_codes: [],
      }),
    );

    initializeRecordingV3ExportProvenance(root);

    await expect(recordingV3ModeForUploadPath(proxy)).resolves.toBe(
      "uncertified_development",
    );
    await expect(assertRecordingV3UploadAllowed(proxy, null)).rejects.toThrow(
      UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR,
    );

    const sourceWithoutMetadata = JSON.stringify({
      video: [{ type: "source", path: proxy }],
    });
    const certifiedSource = (JSON.parse(graph("certified")) as { video: unknown[] }).video[0];
    const sourceWithForgedMetadata = JSON.stringify({
      video: [{ ...(certifiedSource as object), path: proxy }],
    });
    await expect(recordingV3ModeForExportGraph(sourceWithoutMetadata)).resolves.toBe(
      "uncertified_development",
    );
    await expect(recordingV3ModeForExportGraph(sourceWithForgedMetadata)).resolves.toBe(
      "uncertified_development",
    );
  });

  it("rejects explicit uncertified provenance before touching the file system", async () => {
    await expect(
      assertRecordingV3UploadAllowed("/missing/video.mp4", "uncertified_development"),
    ).rejects.toThrow(UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR);
  });
});

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ffmpegExecutablePath } from "./export-binaries";
import { canonicalizeRecordingCertificationJson } from "./recording-v3-certification-canonical-json";
import {
  bindRecordingV3EvidenceBuffer,
  createRecordingV3CertificationEvidenceArtifact,
  createRecordingV3RuntimeIntegrityQualityEvidence,
} from "./recording-v3-certification-evidence";
import {
  decodeRecordingV3CertificationMasterFrames,
  decodeRecordingV3FixtureOrdinal,
  decodeRecordingV3FixtureTimestampUs,
  type RecordingV3BrowserCertificationFixture,
  verifyRecordingV3CertificationQuality,
} from "./recording-v3-certification-quality";
import { injectDownscaleUpscaleBlur } from "./recording-verifier-faults";
import { generateRecordingVerifierFixture } from "./recording-verifier-fixture";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fillRect(
  frame: Buffer,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  red: number,
  green: number,
  blue: number,
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * width + x) * 4;
      frame.set([blue, green, red, 255], offset);
    }
  }
}

function drawBits(
  frame: Buffer,
  fixture: RecordingV3BrowserCertificationFixture,
  roi: { x: number; y: number; width: number; height: number },
  value: number,
  bits: number,
): void {
  fillRect(frame, fixture.width, roi, 5, 5, 5);
  for (let bit = 0; bit < bits; bit += 1) {
    fillRect(
      frame,
      fixture.width,
      { x: roi.x + bit * 26, y: roi.y, width: 20, height: 40 },
      (value & (2 ** bit)) !== 0 ? 255 : 0,
      (value & (2 ** bit)) !== 0 ? 255 : 0,
      (value & (2 ** bit)) !== 0 ? 255 : 0,
    );
  }
}

function fixtureFrame(fixture: RecordingV3BrowserCertificationFixture, ordinal: number): Buffer {
  const frame = Buffer.alloc(fixture.width * fixture.height * 4);
  fillRect(
    frame,
    fixture.width,
    { x: 0, y: 0, width: fixture.width, height: fixture.height },
    24,
    28,
    36,
  );
  drawBits(frame, fixture, fixture.ordinal_roi, ordinal, 24);
  drawBits(frame, fixture, fixture.timestamp_roi, Math.round((ordinal * 1_000_000) / 60), 32);
  for (const roi of fixture.text_edge_rois) {
    fillRect(frame, fixture.width, roi, 248, 250, 252);
    for (let x = roi.x + 4; x < roi.x + roi.width; x += 7) {
      fillRect(
        frame,
        fixture.width,
        { x, y: roi.y + 4, width: 1, height: roi.height - 8 },
        16,
        19,
        26,
      );
    }
  }
  fillRect(frame, fixture.width, fixture.one_pixel_edge_roi, 17, 19, 24);
  for (
    let x = fixture.one_pixel_edge_roi.x;
    x < fixture.one_pixel_edge_roi.x + fixture.one_pixel_edge_roi.width;
    x += 8
  ) {
    fillRect(
      frame,
      fixture.width,
      { x, y: fixture.one_pixel_edge_roi.y, width: 1, height: fixture.one_pixel_edge_roi.height },
      255,
      255,
      255,
    );
  }
  fillRect(frame, fixture.width, fixture.geometry_anchor_roi, 32, 38, 49);
  fillRect(
    frame,
    fixture.width,
    {
      x: fixture.geometry_anchor_roi.x + 88,
      y: fixture.geometry_anchor_roi.y + 48,
      width: 512,
      height: 144,
    },
    255,
    32,
    192,
  );
  const colors = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
  ] as const;
  fixture.color_samples.forEach((point, index) => {
    const [red, green, blue] = colors[index];
    fillRect(
      frame,
      fixture.width,
      { x: point.x - 32, y: point.y - 32, width: 64, height: 64 },
      red,
      green,
      blue,
    );
  });
  return frame;
}

async function loadFixture(): Promise<RecordingV3BrowserCertificationFixture> {
  const fixturePath = path.resolve("fixtures/recording-v3-certification/fixture.json");
  return JSON.parse(
    await fs.readFile(fixturePath, "utf8"),
  ) as RecordingV3BrowserCertificationFixture;
}

describe("recording V3 browser certification fixture", () => {
  it("tracks deterministic ordinal/timestamp, text, edges, anchors, colors, and motion regions", async () => {
    const fixture = await loadFixture();
    const html = await fs.readFile(
      path.resolve("fixtures/recording-v3-certification/index.html"),
      "utf8",
    );
    expect(fixture).toMatchObject({
      fixture_id: "storycapture-recording-v3-browser-certification",
      width: 1920,
      height: 1080,
      fps: { numerator: 60, denominator: 1 },
      pixel_format: "bgra",
    });
    expect(fixture.text_edge_rois).toHaveLength(3);
    expect(fixture.color_samples).toHaveLength(6);
    expect(html).toContain("__storyCaptureRecordingV3Fixture");
    expect(html).toContain("requestAnimationFrame(draw)");
    expect(html).toContain("TIMESTAMP_US");
  });

  it("computes real metrics for a decoded known-good frame and rejects degraded pixels", async () => {
    const fixture = await loadFixture();
    const ordinal = 42;
    const reference = fixtureFrame(fixture, ordinal);
    expect(decodeRecordingV3FixtureOrdinal(reference, fixture)).toBe(ordinal);
    expect(decodeRecordingV3FixtureTimestampUs(reference, fixture)).toBe(700_000);
    const referenceIdentity = {
      fixture_id: fixture.fixture_id,
      fixture_version: fixture.fixture_version,
      reference_sha256: sha256(reference),
    };

    const knownGood = verifyRecordingV3CertificationQuality({
      fixture,
      reference_identity: referenceIdentity,
      frames: [{ ordinal, reference, candidate: Buffer.from(reference) }],
    });
    expect(knownGood).toMatchObject({
      measurement_scope: "certification_fixture",
      certification_verdict: "passed",
      verdict: "passed",
      lossless_master_hashes_match: true,
      failure_codes: [],
    });
    expect(knownGood.full_frame_luma_ssim?.measured).toBeCloseTo(1, 10);
    expect(knownGood.text_edge_roi_ssim?.measured).toBeCloseTo(1, 10);
    expect(knownGood.p01_edge_contrast_retention?.measured).toBeCloseTo(1, 10);
    expect(knownGood.edge_spread_increase_px?.measured).toBe(0);
    expect(knownGood.overlay_geometry_delta_px?.measured).toBe(0);
    expect(knownGood.color_channel_delta?.measured).toBe(0);

    const degraded = injectDownscaleUpscaleBlur(reference, fixture.width, fixture.height);
    const degradedEvidence = verifyRecordingV3CertificationQuality({
      fixture,
      reference_identity: referenceIdentity,
      frames: [{ ordinal, reference, candidate: degraded }],
    });
    expect(degradedEvidence.certification_verdict).toBe("failed");
    expect(degradedEvidence.failure_codes).toEqual(["artifact_verification_failed"]);
    expect(degradedEvidence.full_frame_luma_ssim?.measured).toBeLessThan(1);
    expect(degradedEvidence.text_edge_roi_ssim?.passed).toBe(false);
    expect(degradedEvidence.p01_edge_contrast_retention?.passed).toBe(false);
  }, 60_000);

  it("decodes reference and candidate masters independently before comparison", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-decode-"));
    tempDirectories.push(directory);
    const referencePath = path.join(directory, "reference.mkv");
    const candidatePath = path.join(directory, "candidate.mkv");
    await Promise.all([
      generateRecordingVerifierFixture(referencePath, { frameCount: 2 }),
      generateRecordingVerifierFixture(candidatePath, { frameCount: 2 }),
    ]);
    const decodeInput = {
      ffmpeg_path: ffmpegExecutablePath(),
      width: 1920,
      height: 1080,
      ordinals: [0, 1],
    } as const;
    const [reference, candidate] = await Promise.all([
      decodeRecordingV3CertificationMasterFrames({
        ...decodeInput,
        master_path: referencePath,
      }),
      decodeRecordingV3CertificationMasterFrames({
        ...decodeInput,
        master_path: candidatePath,
      }),
    ]);
    expect(reference).toHaveLength(2);
    expect(reference.map((frame) => frame.sha256)).toEqual(candidate.map((frame) => frame.sha256));
    expect(reference.every((frame) => frame.bgra.byteLength === 1920 * 1080 * 4)).toBe(true);
  }, 60_000);
});

describe("recording V3 evidence separation and hashing", () => {
  it("keeps runtime visual metrics null and binds every certification input/output", async () => {
    const fixture = await loadFixture();
    const reference = fixtureFrame(fixture, 1);
    const quality = verifyRecordingV3CertificationQuality({
      fixture,
      reference_identity: {
        fixture_id: fixture.fixture_id,
        fixture_version: fixture.fixture_version,
        reference_sha256: sha256(reference),
      },
      frames: [{ ordinal: 1, reference, candidate: Buffer.from(reference) }],
    });
    const runtime = createRecordingV3RuntimeIntegrityQualityEvidence({
      evaluated_frames: 1,
      passed: true,
    });
    expect(runtime).toMatchObject({
      measurement_scope: "runtime_integrity",
      reference_identity: null,
      full_frame_luma_ssim: null,
      certification_verdict: null,
    });

    const input = bindRecordingV3EvidenceBuffer({
      role: "reference_master",
      file_name: "reference.mkv",
      measurement_scope: "certification_fixture",
      value: reference,
    });
    const output = bindRecordingV3EvidenceBuffer({
      role: "quality_evidence",
      file_name: "quality.json",
      measurement_scope: "certification_fixture",
      value: Buffer.from(canonicalizeRecordingCertificationJson(quality)),
    });
    const artifact = createRecordingV3CertificationEvidenceArtifact({
      fixture_id: fixture.fixture_id,
      fixture_version: fixture.fixture_version,
      generated_at: "2026-07-21T00:00:00.000Z",
      inputs: [input],
      outputs: [output],
      quality_evidence: quality,
    });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.artifact.inputs[0]).toMatchObject({
      byte_length: reference.byteLength,
      sha256: sha256(reference),
    });
    expect(() =>
      bindRecordingV3EvidenceBuffer({
        role: "private-signing-key",
        file_name: "release.pem",
        measurement_scope: "certification_fixture",
        value: Buffer.from("secret"),
      }),
    ).toThrow("Private signing-key material");
  }, 30_000);
});

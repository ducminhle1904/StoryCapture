import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeRecording } from "./media-probe";
import {
  applyProbeToCadenceObservation,
  verifyRecordingCadence,
} from "./recording-cadence-verifier";
import { RecordingMasterEncoder, verifyMasterAndCreateProxy } from "./recording-master";
import { SequentialMasterDecoder } from "./recording-master-decoder";
import { verifyRecordingQuality } from "./recording-quality-verifier";
import { createPassingCadenceObservation, injectArtifactFault } from "./recording-verifier-faults";
import {
  createRecordingVerifierFixtureSample,
  RECORDING_FIXTURE_HEIGHT,
  RECORDING_FIXTURE_WIDTH,
  recordingVerifierFixtureManifest,
} from "./recording-verifier-fixture";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("recording master and verifier integration", () => {
  it("verifies the lossless master and proxy cadence, and reports injected artifact faults", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-master-verifier-"));
    roots.push(root);
    const masterPath = path.join(root, "master.mkv");
    const proxyPath = path.join(root, "proxy.mp4");
    const samples = Array.from({ length: 3 }, (_, index) =>
      createRecordingVerifierFixtureSample(index),
    );
    const ledger = samples.map((sample, index) => ({
      frame_index: index,
      source_sequence: sample.source_sequence,
      native_pts_us: sample.monotonic_timestamp_us,
      sha256: createHash("sha256").update(sample.frame).digest("hex"),
    }));

    const encoder = new RecordingMasterEncoder(
      RECORDING_FIXTURE_WIDTH,
      RECORDING_FIXTURE_HEIGHT,
      masterPath,
    );
    encoder.start();
    for (const sample of samples) await encoder.writeFrame(sample.frame);
    await encoder.close();
    await verifyMasterAndCreateProxy({
      masterPath,
      proxyPath,
      width: RECORDING_FIXTURE_WIDTH,
      height: RECORDING_FIXTURE_HEIGHT,
      ledger,
    });

    const masterDecoder = new SequentialMasterDecoder(
      masterPath,
      RECORDING_FIXTURE_WIDTH,
      RECORDING_FIXTURE_HEIGHT,
    );
    const decodedMasterFrames: Buffer[] = [];
    for (let index = 0; index < samples.length; index += 1) {
      decodedMasterFrames.push(Buffer.from(await masterDecoder.readFrame(index)));
    }
    masterDecoder.close();

    const quality = verifyRecordingQuality({
      profile: "software",
      manifest: recordingVerifierFixtureManifest(),
      frames: decodedMasterFrames.map((actual, index) => ({
        reference: samples[index].frame,
        actual,
        expected_ordinal: index,
      })),
      lossless_master_hashes_match: true,
    });
    expect(quality).toMatchObject({ verdict: "passed", failure_codes: [] });

    const proxyProbe = await probeRecording(proxyPath);
    const observed = applyProbeToCadenceObservation(
      createPassingCadenceObservation(samples.length),
      proxyProbe,
      { width: RECORDING_FIXTURE_WIDTH, height: RECORDING_FIXTURE_HEIGHT, codec: "h264" },
    );
    expect(verifyRecordingCadence(observed)).toMatchObject({
      verdict: "passed",
      failure_codes: [],
      artifact_decoded_frames: samples.length,
    });

    expect(proxyProbe.status).toBe("valid");
    if (proxyProbe.status !== "valid") throw new Error("Proxy probe unexpectedly failed.");
    const corrupted = applyProbeToCadenceObservation(
      createPassingCadenceObservation(samples.length),
      injectArtifactFault(proxyProbe, "truncation"),
      { width: RECORDING_FIXTURE_WIDTH, height: RECORDING_FIXTURE_HEIGHT, codec: "h264" },
    );
    expect(verifyRecordingCadence(corrupted).failure_codes).toEqual(
      expect.arrayContaining(["artifact_frame_count_mismatch", "artifact_truncated"]),
    );
  }, 60_000);
});

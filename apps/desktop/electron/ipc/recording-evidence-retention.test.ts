import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { retainRecordingVerificationEvidence } from "./recording-evidence-retention";

const tempDirs: string[] = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-evidence-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("recording verifier evidence retention", () => {
  it("always keeps JSON and removes video/reference artifacts after a pass", async () => {
    const directory = await temporaryDirectory();
    const artifacts = [path.join(directory, "video.mkv"), path.join(directory, "reference.bgra")];
    await Promise.all(artifacts.map((artifact) => fs.writeFile(artifact, "fixture")));

    const result = await retainRecordingVerificationEvidence({
      directory,
      artifactPaths: artifacts,
      status: "passed",
      evidence: { verdict: "passed" },
    });

    await expect(fs.readFile(result.evidencePath, "utf8")).resolves.toContain('"status": "passed"');
    await expect(Promise.all(artifacts.map((artifact) => fs.stat(artifact)))).rejects.toThrow();
    expect(result.record.retained_artifacts).toEqual([]);
  });

  it("keeps video/reference artifacts with JSON after a failure", async () => {
    const directory = await temporaryDirectory();
    const artifacts = [path.join(directory, "video.mkv"), path.join(directory, "reference.bgra")];
    await Promise.all(artifacts.map((artifact) => fs.writeFile(artifact, "fixture")));

    const result = await retainRecordingVerificationEvidence({
      directory,
      artifactPaths: artifacts,
      status: "failed",
      evidence: null,
      error: "artifact_pts_gap",
    });

    const persisted = JSON.parse(await fs.readFile(result.evidencePath, "utf8"));
    expect(persisted).toMatchObject({
      status: "failed",
      error: "artifact_pts_gap",
      retained_artifacts: ["video.mkv", "reference.bgra"],
    });
    await expect(Promise.all(artifacts.map((artifact) => fs.stat(artifact)))).resolves.toHaveLength(
      2,
    );
  });
});

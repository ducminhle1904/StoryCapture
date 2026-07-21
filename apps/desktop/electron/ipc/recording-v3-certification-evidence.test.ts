import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bindRecordingV3EvidenceFile } from "./recording-v3-certification-evidence";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Recording V3 certification file evidence", () => {
  it("streams the artifact hash without reading the whole file into memory", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-evidence-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "master.mkv");
    const value = Buffer.from("immutable certification artifact");
    await fs.writeFile(filePath, value);
    const readFile = vi.spyOn(fs, "readFile");

    await expect(
      bindRecordingV3EvidenceFile({
        role: "candidate_master",
        file_path: filePath,
        measurement_scope: "certification_fixture",
      }),
    ).resolves.toEqual({
      role: "candidate_master",
      file_name: "master.mkv",
      measurement_scope: "certification_fixture",
      byte_length: value.byteLength,
      sha256: createHash("sha256").update(value).digest("hex"),
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects nonlocal evidence names before binding them", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v3-evidence-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "master.mkv");
    await fs.writeFile(filePath, "artifact");

    await expect(
      bindRecordingV3EvidenceFile({
        role: "candidate_master",
        file_path: filePath,
        artifact_file_name: "../master.mkv",
        measurement_scope: "certification_fixture",
      }),
    ).rejects.toThrow("artifact-local file names");
  });
});

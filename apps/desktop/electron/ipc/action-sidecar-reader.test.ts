import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import v1Raw from "../../src/ipc/__fixtures__/action-sidecars/v1-short-gap.actions.json";
import v1Normalized from "../../src/ipc/__fixtures__/action-sidecars/v1-short-gap.normalized.json";
import { readRecordingActionsSidecar } from "./action-sidecar-reader";
import { actionsSidecarPath } from "./action-timeline";

const tempDirs: string[] = [];

async function recordingFixturePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-action-reader-"));
  tempDirs.push(dir);
  return path.join(dir, "recording.mp4");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readRecordingActionsSidecar", () => {
  it("returns normalized actions for a valid sidecar", async () => {
    const recordingPath = await recordingFixturePath();
    await fs.writeFile(actionsSidecarPath(recordingPath), JSON.stringify(v1Raw));

    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toEqual(v1Normalized);
  });

  it("reads the explicit V2 bundle sidecar and rejects paths outside the bundle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-action-reader-v2-"));
    tempDirs.push(root);
    const recordingPath = path.join(root, "take.sc-recording", "proxy", "video.mp4");
    const actionsPath = path.join(root, "take.sc-recording", "sidecars", "actions.json");
    await fs.mkdir(path.dirname(recordingPath), { recursive: true });
    await fs.mkdir(path.dirname(actionsPath), { recursive: true });
    await fs.writeFile(actionsPath, JSON.stringify(v1Raw));

    await expect(readRecordingActionsSidecar(recordingPath, actionsPath)).resolves.toEqual(
      v1Normalized,
    );
    await expect(
      readRecordingActionsSidecar(recordingPath, path.join(root, "outside.actions.json")),
    ).rejects.toThrow(/outside the V2 bundle/);
  });

  it("returns null for missing, malformed, partial, and future sidecars", async () => {
    const recordingPath = await recordingFixturePath();
    const actionsPath = actionsSidecarPath(recordingPath);

    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
    await fs.writeFile(actionsPath, "{not-json");
    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
    await fs.writeFile(actionsPath, JSON.stringify({ version: 2, events: [] }));
    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
    await fs.writeFile(actionsPath, JSON.stringify({ ...v1Raw, version: 99 }));
    await expect(readRecordingActionsSidecar(recordingPath)).resolves.toBeNull();
  });

  it("does not hide non-ENOENT filesystem failures", async () => {
    const recordingPath = await recordingFixturePath();
    await fs.mkdir(actionsSidecarPath(recordingPath));

    await expect(readRecordingActionsSidecar(recordingPath)).rejects.toBeDefined();
  });
});

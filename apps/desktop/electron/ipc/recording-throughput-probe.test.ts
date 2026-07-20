import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureRecordingMasterThroughput } from "./recording-throughput-probe";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("recording master throughput probe", () => {
  it("measures a real FFV1 encoder run and removes its temporary artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-throughput-"));
    roots.push(root);
    const ratio = await measureRecordingMasterThroughput(
      root,
      {
        version: 2,
        delivery_policy: "strict",
        target_class: "browser",
        requested_fps: { numerator: 60, denominator: 1 },
        dimensions: {
          logical_width: 16,
          logical_height: 16,
          capture_dpr: 1,
          physical_width: 16,
          physical_height: 16,
          requested_output_width: 16,
          requested_output_height: 16,
        },
        audio_roles: [],
        desired_tier: null,
      },
      { frameCount: 6 },
    );
    expect(ratio).toBeGreaterThan(0);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });
});

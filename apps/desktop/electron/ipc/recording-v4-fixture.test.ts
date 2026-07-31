import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fixturePath = path.resolve("e2e/fixtures/recording-v4/index.html");

describe("Recording V4 author-preview fixture", () => {
  it("keeps checkpoint identifiers in the verifier API instead of visible output", async () => {
    const source = await fs.readFile(fixturePath, "utf8");
    expect(source).toContain("__STORYCAPTURE_RECORDING_V4_FIXTURE__");
    expect(source).toContain('reference_id: "static-text-hairline-color"');
    expect(source).not.toMatch(/<[^>]+>[^<]*static-text-hairline-color/);
  });

  it("derives frame slots and PTS from elapsed time at exactly 60 Hz", async () => {
    const source = await fs.readFile(fixturePath, "utf8");
    expect(source).toContain("Math.round((elapsedMs * 60) / 1000)");
    expect(source).toContain("Math.round((slot * 1000000) / 60)");
    expect(source).toContain('scene === "motion"');
  });
});

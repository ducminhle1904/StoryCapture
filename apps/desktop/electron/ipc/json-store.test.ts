import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeJsonAtomic } from "./json-store";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("JSON store", () => {
  it("keeps concurrent atomic writes isolated when they start in the same millisecond", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-json-store-"));
    tempDirs.push(dir);
    const file = path.join(dir, "projects.json");
    vi.spyOn(Date, "now").mockReturnValue(1234);

    const values = Array.from({ length: 8 }, (_, index) => ({ index }));
    await Promise.all(values.map((value) => writeJsonAtomic(file, value)));

    const stored = JSON.parse(await fs.readFile(file, "utf8")) as { index: number };
    expect(values).toContainEqual(stored);
    expect(await fs.readdir(dir)).toEqual(["projects.json"]);
  });
});

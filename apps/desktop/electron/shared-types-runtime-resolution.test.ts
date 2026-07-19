import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("shared-types runtime resolution", () => {
  it("loads the export composition values through Node ESM", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import("@storycapture/shared-types/export-composition").then((module) => console.log(module.EXPORT_FOREGROUND_SCALE_DEFAULT))',
      ],
      { cwd: desktopDir, encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.85");
  });
});

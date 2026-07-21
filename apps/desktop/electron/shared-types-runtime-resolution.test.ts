import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNodeEsm(expression: string): string {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", expression], {
    cwd: desktopDir,
    encoding: "utf8",
  });

  expect(result.status, result.stderr).toBe(0);
  expect(stripVTControlCharacters(result.stderr).trim()).toBe("");
  return result.stdout.trim();
}

describe("shared-types runtime resolution", () => {
  it("loads the recording values through Node ESM", () => {
    expect(
      runNodeEsm(
        'import("@storycapture/shared-types/recording-v2").then((module) => console.log(module.RECORDING_CONTRACT_VERSION + ":" + module.RECORDING_CONTRACT_VERSION_V3))',
      ),
    ).toBe("2:3");
  });

  it("loads the export composition values through Node ESM", () => {
    expect(
      runNodeEsm(
        'import("@storycapture/shared-types/export-composition").then((module) => console.log(module.EXPORT_FOREGROUND_SCALE_DEFAULT))',
      ),
    ).toBe("0.85");
  });
});

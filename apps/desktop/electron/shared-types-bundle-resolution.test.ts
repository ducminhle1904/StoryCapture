import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { bundleSharedTypesPlugin } from "../scripts/esbuild-shared-types-plugin.mjs";

describe("shared-types packaged bundle resolution", () => {
  it("bundles public shared-types runtime exports while other packages remain external", async () => {
    const result = await build({
      stdin: {
        contents: [
          'import { RECORDING_CONTRACT_VERSION, RECORDING_CONTRACT_VERSION_V3 } from "@storycapture/shared-types/recording-v2";',
          'import { EXPORT_FOREGROUND_SCALE_DEFAULT } from "@storycapture/shared-types/export-composition";',
          "console.log(RECORDING_CONTRACT_VERSION, RECORDING_CONTRACT_VERSION_V3, EXPORT_FOREGROUND_SCALE_DEFAULT);",
        ].join("\n"),
        resolveDir: process.cwd(),
        sourcefile: "shared-types-bundle-smoke.ts",
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      packages: "external",
      plugins: [bundleSharedTypesPlugin()],
      write: false,
    });

    const output = result.outputFiles[0]?.text ?? "";
    expect(output).not.toContain("@storycapture/shared-types");

    const execution = spawnSync(process.execPath, ["--input-type=module", "--eval", output], {
      encoding: "utf8",
    });
    expect(execution.status, execution.stderr).toBe(0);
    expect(stripVTControlCharacters(execution.stderr).trim()).toBe("");
    expect(execution.stdout.trim()).toBe("2 3 0.85");
  });
});

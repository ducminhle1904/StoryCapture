import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const generatedRoot = join(packageRoot, "src/theme/generated");
const temporaryRoot = mkdtempSync(join(tmpdir(), "storycapture-theme-"));
const outputCss = join(temporaryRoot, "storycapture-gothic.css");
const generatedFiles = [
  "storycapture-gothic.css",
  "storycapture-gothic.js",
  "storycapture-gothic.d.ts",
];

function normalizeGenerated(source) {
  return source
    .replace(/^ \* Command: .*$/gm, " * Command: <deterministic>")
    .replace(/^ \* Generated: .*$/gm, " * Generated: <deterministic>");
}

try {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    command,
    ["exec", "astryx", "theme", "build", "src/theme/storycapture-gothic.ts", "--out", outputCss],
    { cwd: packageRoot, encoding: "utf8" },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }

  const stale = generatedFiles.filter((file) => {
    const expected = normalizeGenerated(readFileSync(join(generatedRoot, file), "utf8"));
    const actual = normalizeGenerated(
      readFileSync(join(dirname(outputCss), basename(file)), "utf8"),
    );
    if (expected === actual) return false;
    const expectedLines = expected.split("\n");
    const actualLines = actual.split("\n");
    const line = expectedLines.findIndex((value, index) => value !== actualLines[index]);
    console.error(
      `${file}:${line + 1}\n  committed: ${expectedLines[line]}\n  generated: ${actualLines[line]}`,
    );
    return true;
  });

  if (stale.length > 0) {
    console.error(
      `Generated Gothic theme is stale: ${stale.join(", ")}. Run pnpm theme:build and commit the output.`,
    );
    process.exit(1);
  }

  console.log("Generated Gothic theme artifacts are current.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

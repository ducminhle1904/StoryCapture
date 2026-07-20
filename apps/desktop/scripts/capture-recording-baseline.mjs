import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);
const targets = ["browser", "display", "window"];

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Expected --name value, received ${key}.`);
    }
    values.set(key.slice(2), argv[index + 1]);
    index += 1;
  }
  return values;
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function probe(filePath) {
  const stat = await fs.stat(filePath);
  const { stdout } = await execFileAsync(
    ffprobeInstaller.path,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-show_entries",
      "stream=codec_name,profile,pix_fmt,color_range,color_space,color_transfer,color_primaries,width,height,r_frame_rate,avg_frame_rate,time_base,bit_rate,nb_frames,nb_read_frames,duration:format=format_name,duration,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
  );
  const metadata = JSON.parse(stdout);
  const decode = await execFileAsync(
    ffmpegPath,
    ["-v", "error", "-xerror", "-i", filePath, "-map", "0:v:0", "-f", "null", "-"],
    { timeout: 120_000 },
  ).then(
    () => true,
    () => false,
  );
  return {
    status: "captured",
    path: path.resolve(filePath),
    bytes: stat.size,
    sha256: await sha256(filePath),
    full_decode_succeeded: decode,
    metadata,
  };
}

const argumentsMap = parseArguments(process.argv.slice(2));
const outputPath = path.resolve(
  argumentsMap.get("output") ?? path.join(process.cwd(), "recording-baseline-evidence.json"),
);
const evidence = {
  version: 1,
  captured_at: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  interactive_terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  targets: {},
};

for (const target of targets) {
  const artifactPath = argumentsMap.get(target);
  if (!artifactPath) {
    evidence.targets[target] = {
      status: "not_captured",
      reason:
        "No current-build artifact was supplied. This non-interactive collector does not launch a browser, request screen permissions, select a display/window, or synthesize an artifact.",
    };
    continue;
  }
  evidence.targets[target] = await probe(artifactPath).catch((error) => ({
    status: "capture_invalid",
    path: path.resolve(artifactPath),
    reason: error instanceof Error ? error.message : String(error),
  }));
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp`;
await fs.writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fs.rename(temporaryPath, outputPath);
console.log(outputPath);

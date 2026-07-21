import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RecordingPreflightV3Request } from "@storycapture/shared-types/recording-v2";
import { probeRecordingV3RuntimeCapability } from "./ipc/recording-v3-runtime-preflight";

const RELEASE_REQUEST: RecordingPreflightV3Request = {
  version: 3,
  intent: "strict",
  target_class: "browser",
  requested_fps: { numerator: 60, denominator: 1 },
  dimensions: {
    logical_width: 960,
    logical_height: 540,
    capture_dpr: 2,
    physical_width: 1920,
    physical_height: 1080,
    requested_output_width: 1920,
    requested_output_height: 1080,
  },
  cursor_policy: "sidecar_reconstructed",
  audio_roles: [],
};

async function writeResultAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

export async function runRecordingV3ReleaseSmoke(resultPath: string): Promise<boolean> {
  try {
    const fixtureUrl = pathToFileURL(
      path.join(process.resourcesPath, "recording-v3-certification-fixture", "index.html"),
    );
    fixtureUrl.searchParams.set("fixture", "motion");
    const preflight = await probeRecordingV3RuntimeCapability({
      request: RELEASE_REQUEST,
      projectFolder: path.dirname(resultPath),
      url: fixtureUrl.href,
    });
    const passed =
      preflight.strict_eligible &&
      preflight.failure_codes.length === 0 &&
      preflight.matched_profile?.stage === "certified";
    await writeResultAtomic(resultPath, { schema_version: 1, passed, preflight });
    return passed;
  } catch (error) {
    await writeResultAtomic(resultPath, {
      schema_version: 1,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

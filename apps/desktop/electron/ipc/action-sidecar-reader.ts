import fs from "node:fs/promises";

import { parseActionSidecarJson } from "../../src/ipc/action-sidecar";
import { actionsSidecarPath } from "./action-timeline";

export async function readRecordingActionsSidecar(recordingPath: string) {
  try {
    return parseActionSidecarJson(await fs.readFile(actionsSidecarPath(recordingPath), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

import fs from "node:fs/promises";
import path from "node:path";

import { parseActionSidecarJson } from "../../src/ipc/action-sidecar";
import { actionsSidecarPath } from "./action-timeline";

function resolvedActionsPath(recordingPath: string, explicitActionsPath?: string | null): string {
  if (!explicitActionsPath) return actionsSidecarPath(recordingPath);
  const bundlePath = path.dirname(path.dirname(path.resolve(recordingPath)));
  const expectedPath = path.join(bundlePath, "sidecars", "actions.json");
  if (path.resolve(explicitActionsPath) !== expectedPath) {
    throw new Error("recording actions path is outside the V2 bundle contract");
  }
  return expectedPath;
}

export async function readRecordingActionsSidecar(
  recordingPath: string,
  explicitActionsPath?: string | null,
) {
  try {
    return parseActionSidecarJson(
      await fs.readFile(resolvedActionsPath(recordingPath, explicitActionsPath), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

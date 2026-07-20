import fs from "node:fs/promises";
import path from "node:path";
import { readRecordingBundleV2 } from "@storycapture/shared-types/recording-v2";
import type { InvokeHandlers } from "./types";

export async function deleteFailedRecordingBundle(
  projectFolder: string,
  bundlePath: string,
): Promise<void> {
  const exportsDir = path.resolve(projectFolder, "exports");
  const resolvedBundle = path.resolve(bundlePath);
  const relative = path.relative(exportsDir, resolvedBundle);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    !relative.endsWith(".sc-recording")
  ) {
    throw new Error("Failed recording bundle is outside this project's exports directory.");
  }
  const stat = await fs.lstat(resolvedBundle);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Failed recording bundle must be a real directory.");
  }
  const manifest = await fs
    .readFile(path.join(resolvedBundle, "manifest.json"), "utf8")
    .then((text) => readRecordingBundleV2(JSON.parse(text) as unknown));
  if (!manifest || manifest.status !== "quality_failed") {
    throw new Error("Only a validated quality-failed recording bundle can be deleted here.");
  }
  await fs.rm(resolvedBundle, { recursive: true, force: true });
}

export const recordingFailedBundleHandlers = {
  recording_delete_failed_bundle: async (args) => {
    const outer = (args ?? {}) as Record<string, unknown>;
    const value = (outer.args as Record<string, unknown> | undefined) ?? outer;
    await deleteFailedRecordingBundle(
      String(value.project_folder ?? ""),
      String(value.bundle_path ?? ""),
    );
    return null;
  },
} satisfies InvokeHandlers;

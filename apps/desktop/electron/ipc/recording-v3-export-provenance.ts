import fs from "node:fs/promises";
import path from "node:path";
import {
  readExportRecordingSource,
  readRecordingBundle,
} from "@storycapture/shared-types/recording-v2";
import type { RecordingV3Mode } from "@storycapture/shared-types/recording-v3";

import { readJson, writeJsonAtomic } from "./json-store";

const REGISTRY_FILENAME = "recording-v3-export-provenance.json";
const UNCERTIFIED_SUFFIX = "-uncertified-dev";

interface ExportProvenanceRegistry {
  version: 1;
  entries: Record<string, { recording_mode: "uncertified_development"; registered_at: number }>;
}

let registryPath: string | null = null;
let registryWrite: Promise<void> = Promise.resolve();

export const UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR =
  "Uncertified Development recordings and exports cannot be uploaded or shared.";

function emptyRegistry(): ExportProvenanceRegistry {
  return { version: 1, entries: {} };
}

async function canonicalPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  return fs.realpath(resolved).catch(async () => {
    const parent = await fs.realpath(path.dirname(resolved));
    return path.join(parent, path.basename(resolved));
  });
}

async function readRegistry(): Promise<ExportProvenanceRegistry> {
  if (!registryPath) return emptyRegistry();
  const value = await readJson<unknown>(registryPath, null);
  if (!value || typeof value !== "object") return emptyRegistry();
  const candidate = value as Partial<ExportProvenanceRegistry>;
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
    return emptyRegistry();
  }
  return { version: 1, entries: candidate.entries } as ExportProvenanceRegistry;
}

export function initializeRecordingV3ExportProvenance(userDataDirectory: string): void {
  registryPath = path.join(userDataDirectory, REGISTRY_FILENAME);
  registryWrite = Promise.resolve();
}

export function recordingV3ModeFromExportGraph(graphJson: string): RecordingV3Mode | null {
  const graph = JSON.parse(graphJson) as { video?: unknown };
  if (!Array.isArray(graph.video)) return null;
  let mode: RecordingV3Mode | null = null;
  for (const rawNode of graph.video) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const node = rawNode as { type?: unknown; recording_source?: unknown };
    if (node.type !== "source" || !node.recording_source) continue;
    const rawSource = node.recording_source as { version?: unknown };
    if (rawSource.version !== 3) continue;
    const source = readExportRecordingSource(node.recording_source);
    if (!source || source.version !== 3) {
      throw new Error("export graph contains invalid Recording V3 provenance");
    }
    if (source.recording_mode === "uncertified_development") {
      return "uncertified_development";
    }
    mode = "certified";
  }
  return mode;
}

export async function recordingV3ModeForExportGraph(
  graphJson: string,
): Promise<RecordingV3Mode | null> {
  let mode = recordingV3ModeFromExportGraph(graphJson);
  const graph = JSON.parse(graphJson) as { video?: unknown };
  if (!Array.isArray(graph.video)) return mode;
  for (const rawNode of graph.video) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const node = rawNode as { type?: unknown; path?: unknown };
    if (node.type !== "source" || typeof node.path !== "string") continue;
    const actualMode = await recordingV3ModeForUploadPath(node.path);
    if (actualMode === "uncertified_development") return actualMode;
    if (actualMode === "certified" && mode === null) mode = actualMode;
  }
  return mode;
}

export function suffixUncertifiedDevelopmentBaseName(baseName: string): string {
  return baseName.endsWith(UNCERTIFIED_SUFFIX) ? baseName : `${baseName}${UNCERTIFIED_SUFFIX}`;
}

export async function registerUncertifiedDevelopmentExport(filePath: string): Promise<void> {
  if (!registryPath) throw new Error("Recording V3 export provenance registry is not initialized");
  const key = await canonicalPath(filePath);
  const update = registryWrite.catch(() => undefined).then(async () => {
    const registry = await readRegistry();
    registry.entries[key] = {
      recording_mode: "uncertified_development",
      registered_at: Date.now(),
    };
    await writeJsonAtomic(registryPath!, registry);
  });
  registryWrite = update;
  await update;
}

function uncertifiedSuffixPresent(filePath: string): boolean {
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return /-uncertified-dev(?:-|$)/.test(stem);
}

function recordingBundleRoot(filePath: string): string | null {
  let current = path.dirname(filePath);
  while (true) {
    if (path.basename(current).toLowerCase().endsWith(".sc-recording")) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function bundleRecordingMode(filePath: string): Promise<RecordingV3Mode | null> {
  const bundleRoot = recordingBundleRoot(filePath);
  if (!bundleRoot) return null;
  const raw = await fs
    .readFile(path.join(bundleRoot, "manifest.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const bundle = readRecordingBundle(raw);
  if (!bundle) throw new Error("Cannot verify recording bundle provenance for upload.");
  return bundle.schema_version === 3 ? bundle.recording_mode : null;
}

export async function recordingV3ModeForUploadPath(filePath: string): Promise<RecordingV3Mode | null> {
  const canonical = await canonicalPath(filePath);
  const bundleMode = await bundleRecordingMode(canonical);
  if (bundleMode) return bundleMode;
  const registered = (await readRegistry()).entries[canonical]?.recording_mode ?? null;
  if (registered) return registered;
  return uncertifiedSuffixPresent(canonical) ? "uncertified_development" : null;
}

export async function assertRecordingV3UploadAllowed(
  filePath: string,
  claimedMode: unknown,
): Promise<void> {
  if (claimedMode === "uncertified_development") {
    throw new Error(UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR);
  }
  const actualMode = await recordingV3ModeForUploadPath(filePath);
  if (actualMode === "uncertified_development") {
    throw new Error(UNCERTIFIED_DEVELOPMENT_UPLOAD_ERROR);
  }
}

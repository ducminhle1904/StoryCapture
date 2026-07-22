import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeRecordingV3Mode,
  readExportRecordingSource,
  readRecordingBundle,
} from "@storycapture/shared-types/recording-v2";
import type { RecordingV3Mode } from "@storycapture/shared-types/recording-v3";

import { readJson, writeJsonAtomic } from "./json-store";

const REGISTRY_FILENAME = "recording-v3-export-provenance.json";
const STRICT_LOCAL_SUFFIX = "-strict-local";

interface ExportProvenanceRegistry {
  version: 1;
  entries: Record<
    string,
    {
      recording_mode: RecordingV3Mode;
      certification_verified: boolean;
      registered_at: number;
    }
  >;
}

interface RecordingV3PathProvenance {
  recordingMode: RecordingV3Mode;
  certificationVerified: boolean;
}

let registryPath: string | null = null;
let registryWrite: Promise<void> = Promise.resolve();

export const STRICT_LOCAL_UPLOAD_ERROR =
  "Strict Local recordings and exports are runtime-verified but not release-certified, so they cannot be uploaded or shared.";
export const STRICT_CERTIFIED_UPLOAD_ERROR =
  "Recording V3 uploads require a completed Strict Certified artifact with verified certification provenance.";

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
  const entries: ExportProvenanceRegistry["entries"] = {};
  for (const [key, rawEntry] of Object.entries(candidate.entries)) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as {
      recording_mode?: unknown;
      certification_verified?: unknown;
      registered_at?: unknown;
    };
    const recordingMode = normalizeRecordingV3Mode(entry.recording_mode);
    if (!recordingMode || typeof entry.registered_at !== "number") continue;
    entries[key] = {
      recording_mode: recordingMode,
      certification_verified:
        recordingMode === "strict_certified" && entry.certification_verified === true,
      registered_at: entry.registered_at,
    };
  }
  return { version: 1, entries };
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
    if (source.recording_mode === "strict_local") {
      return "strict_local";
    }
    mode = "strict_certified";
  }
  return mode;
}

export async function recordingV3ModeForExportGraph(
  graphJson: string,
): Promise<RecordingV3Mode | null> {
  const graph = JSON.parse(graphJson) as { video?: unknown };
  if (!Array.isArray(graph.video)) return null;
  let mode: RecordingV3Mode | null = null;
  for (const rawNode of graph.video) {
    if (!rawNode || typeof rawNode !== "object") continue;
    const node = rawNode as { type?: unknown; path?: unknown; recording_source?: unknown };
    if (node.type !== "source") continue;
    const source = node.recording_source
      ? readExportRecordingSource(node.recording_source)
      : null;
    if (node.recording_source && !source) {
      throw new Error("export graph contains invalid Recording V3 provenance");
    }
    const claimedMode = source?.version === 3 ? source.recording_mode : null;
    const actual =
      typeof node.path === "string" ? await recordingV3ProvenanceForPath(node.path) : null;
    if (claimedMode === "strict_local" || actual?.recordingMode === "strict_local") {
      return "strict_local";
    }
    if (claimedMode === "strict_certified") {
      if (actual?.recordingMode !== "strict_certified" || !actual.certificationVerified) {
        throw new Error(STRICT_CERTIFIED_UPLOAD_ERROR);
      }
      mode = "strict_certified";
      continue;
    }
    if (actual?.recordingMode === "strict_certified") {
      if (!actual.certificationVerified) throw new Error(STRICT_CERTIFIED_UPLOAD_ERROR);
      mode = "strict_certified";
    }
  }
  return mode;
}

export function suffixStrictLocalBaseName(baseName: string): string {
  return baseName.endsWith(STRICT_LOCAL_SUFFIX) ? baseName : `${baseName}${STRICT_LOCAL_SUFFIX}`;
}

export async function registerRecordingV3Export(
  filePath: string,
  recordingMode: RecordingV3Mode,
): Promise<void> {
  if (!registryPath) throw new Error("Recording V3 export provenance registry is not initialized");
  const key = await canonicalPath(filePath);
  const update = registryWrite.catch(() => undefined).then(async () => {
    const registry = await readRegistry();
    registry.entries[key] = {
      recording_mode: recordingMode,
      certification_verified: recordingMode === "strict_certified",
      registered_at: Date.now(),
    };
    await writeJsonAtomic(registryPath!, registry);
  });
  registryWrite = update;
  await update;
}

export async function registerStrictLocalExport(filePath: string): Promise<void> {
  await registerRecordingV3Export(filePath, "strict_local");
}

function strictLocalSuffixPresent(filePath: string): boolean {
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return (
    stem.endsWith(STRICT_LOCAL_SUFFIX) ||
    /-uncertified-dev(?:-|$)/.test(stem)
  );
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

async function bundleRecordingProvenance(
  filePath: string,
): Promise<RecordingV3PathProvenance | null> {
  const bundleRoot = recordingBundleRoot(filePath);
  if (!bundleRoot) return null;
  const raw = await fs
    .readFile(path.join(bundleRoot, "manifest.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const bundle = readRecordingBundle(raw);
  if (!bundle) throw new Error("Cannot verify recording bundle provenance for upload.");
  if (bundle.schema_version !== 3) return null;
  return {
    recordingMode: bundle.recording_mode,
    certificationVerified:
      bundle.status === "completed" &&
      bundle.recording_mode === "strict_certified" &&
      bundle.certification_profile !== null,
  };
}

async function recordingV3ProvenanceForPath(
  filePath: string,
): Promise<RecordingV3PathProvenance | null> {
  const canonical = await canonicalPath(filePath);
  const bundle = await bundleRecordingProvenance(canonical);
  if (bundle) return bundle;
  const registered = (await readRegistry()).entries[canonical];
  if (registered) {
    return {
      recordingMode: registered.recording_mode,
      certificationVerified: registered.certification_verified,
    };
  }
  return strictLocalSuffixPresent(canonical)
    ? { recordingMode: "strict_local", certificationVerified: false }
    : null;
}

export async function recordingV3ModeForUploadPath(filePath: string): Promise<RecordingV3Mode | null> {
  return (await recordingV3ProvenanceForPath(filePath))?.recordingMode ?? null;
}

export async function assertRecordingV3UploadAllowed(
  filePath: string,
  claimedMode: unknown,
): Promise<void> {
  const normalizedClaim = normalizeRecordingV3Mode(claimedMode);
  if (normalizedClaim === "strict_local") {
    throw new Error(STRICT_LOCAL_UPLOAD_ERROR);
  }
  const actual = await recordingV3ProvenanceForPath(filePath);
  if (actual?.recordingMode === "strict_local") {
    throw new Error(STRICT_LOCAL_UPLOAD_ERROR);
  }
  if (
    normalizedClaim === "strict_certified" &&
    (actual?.recordingMode !== "strict_certified" || !actual.certificationVerified)
  ) {
    throw new Error(STRICT_CERTIFIED_UPLOAD_ERROR);
  }
  if (actual?.recordingMode === "strict_certified" && !actual.certificationVerified) {
    throw new Error(STRICT_CERTIFIED_UPLOAD_ERROR);
  }
}

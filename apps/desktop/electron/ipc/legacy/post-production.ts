import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { actionsSidecarPath } from "../action-timeline";
import { readJson, writeJson } from "../json-store";
import { pathExists } from "./projects";
import { type EffectPreset, presetStorePath, type SoundLibraryEntry } from "./shared";

export function sidecarPath(
  recordingPath: string,
  suffix: "actions" | "trajectory" | "steps",
): string {
  if (suffix === "actions") return actionsSidecarPath(recordingPath);
  const ext = suffix === "steps" ? ".steps.json" : `.${suffix}.json`;
  return /\.[^/.]+$/.test(recordingPath)
    ? recordingPath.replace(/\.[^/.]+$/, ext)
    : `${recordingPath}${ext}`;
}

export async function readRecordingSidecar(
  recordingPath: string,
  suffix: "actions" | "trajectory" | "steps",
) {
  const file = sidecarPath(recordingPath, suffix);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readPresets(scope: string): Promise<EffectPreset[]> {
  return readJson<EffectPreset[]>(presetStorePath(scope), []);
}

export async function writePresets(scope: string, presets: EffectPreset[]): Promise<void> {
  await writeJson(presetStorePath(scope), presets);
}

export async function presetImport(file: string, scope: string): Promise<string> {
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<EffectPreset>;
  const preset: EffectPreset = {
    id: raw.id ?? randomUUID(),
    scope,
    name: raw.name ?? path.basename(file, path.extname(file)),
    description: raw.description ?? "",
    ast_json: raw.ast_json ?? "{}",
    version: raw.version ?? 1,
    bundled: false,
    created_at: raw.created_at ?? Date.now(),
    author: raw.author ?? null,
    tags: raw.tags ?? [],
  };
  const presets = (await readPresets(scope)).filter((candidate) => candidate.id !== preset.id);
  presets.unshift(preset);
  await writePresets(scope, presets);
  return preset.id;
}

export async function presetExport(id: string, out: string): Promise<void> {
  const presets = [...(await readPresets("project")), ...(await readPresets("global"))];
  const preset = presets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`preset ${id} not found`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(preset, null, 2), "utf8");
}

export function exportPresetsCatalogue() {
  return {
    formats: ["mp4", "webm", "gif"],
    resolutions: ["match-source", "720p", "1080p", "4k", "custom"],
    fps: [24, 30, 60],
    qualities: ["low", "med", "high"],
  };
}

export async function soundLibraryRoot(): Promise<string> {
  const candidates = [
    path.join(app.getAppPath(), "assets", "sound-library"),
    path.join(process.resourcesPath, "assets", "sound-library"),
    path.join(process.cwd(), "assets", "sound-library"),
    path.resolve(app.getAppPath(), "..", "..", "assets", "sound-library"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "manifest.json"))) return candidate;
  }
  return candidates[0] ?? path.join(app.getAppPath(), "assets", "sound-library");
}

export async function soundLibraryList(category: string): Promise<SoundLibraryEntry[]> {
  const root = await soundLibraryRoot();
  const manifestPath = path.join(root, "manifest.json");
  if (!(await pathExists(manifestPath))) return [];
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as {
    entries?: Array<{
      id?: unknown;
      category?: unknown;
      file?: unknown;
      duration_ms?: unknown;
      license?: unknown;
      source_url?: unknown;
      author?: unknown;
    }>;
  };
  const entries = await Promise.all(
    (manifest.entries ?? [])
      .filter((entry) => entry.category === category)
      .map(async (entry): Promise<SoundLibraryEntry | null> => {
        if (typeof entry.id !== "string" || typeof entry.file !== "string") return null;
        const filePath = path.join(root, entry.file);
        const relative = path.relative(root, filePath);
        if (
          relative.startsWith("..") ||
          path.isAbsolute(relative) ||
          !(await pathExists(filePath))
        ) {
          return null;
        }
        return {
          id: entry.id,
          name: entry.id
            .split("-")
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" "),
          category,
          duration_ms:
            typeof entry.duration_ms === "number" && Number.isFinite(entry.duration_ms)
              ? entry.duration_ms
              : 0,
          file_path: filePath,
          license: typeof entry.license === "string" ? entry.license : "Unknown",
          source_url: typeof entry.source_url === "string" ? entry.source_url : undefined,
          author: typeof entry.author === "string" ? entry.author : undefined,
          bundled: true,
        };
      }),
  );
  return entries.filter((entry): entry is SoundLibraryEntry => Boolean(entry));
}

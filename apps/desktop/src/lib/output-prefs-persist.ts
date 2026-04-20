/**
 * Output-prefs persistence: global (plugin-store) + per-project
 * (`<project>/.storycapture/output.json`) IO + migrator.
 *
 * Phase 13 — silent seed on first launch (D-13-06), debounced write-back
 * (250ms), precedence project > global > seed (D-13-05).
 */
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

import { getStore, LATEST_VERSION, STORE_KEY } from "@/ipc/output-prefs";
import {
  DEFAULT_EXPORT_KNOBS,
  PRESET_BUNDLES,
  useOutputPrefsStore,
  type ExportKnobs,
  type PresetName,
  type RecordingKnobs,
} from "@/state/output-prefs";

export interface PersistShape {
  activePreset: PresetName;
  recordingKnobs: RecordingKnobs;
  exportKnobs: ExportKnobs;
  version: typeof LATEST_VERSION;
}

const SEED: PersistShape = {
  activePreset: "Standard",
  recordingKnobs: PRESET_BUNDLES.Standard,
  exportKnobs: DEFAULT_EXPORT_KNOBS,
  version: LATEST_VERSION,
};

type PartialPersist = Partial<{
  activePreset: PresetName;
  recordingKnobs: Partial<RecordingKnobs>;
  exportKnobs: Partial<ExportKnobs> & { audio?: Partial<ExportKnobs["audio"]> };
  version: number;
}>;

export function migrate(raw: unknown): PersistShape {
  if (!raw || typeof raw !== "object") return { ...SEED };
  const r = raw as PartialPersist;
  return {
    activePreset: (r.activePreset ?? SEED.activePreset) as PresetName,
    recordingKnobs: { ...SEED.recordingKnobs, ...(r.recordingKnobs ?? {}) } as RecordingKnobs,
    exportKnobs: {
      ...SEED.exportKnobs,
      ...(r.exportKnobs ?? {}),
      audio: { ...SEED.exportKnobs.audio, ...(r.exportKnobs?.audio ?? {}) },
    } as ExportKnobs,
    version: LATEST_VERSION,
  };
}

export function resolveOverride(
  global: PersistShape,
  project: PartialPersist | null,
): PersistShape {
  if (!project) return global;
  return {
    activePreset: (project.activePreset ?? global.activePreset) as PresetName,
    recordingKnobs: {
      ...global.recordingKnobs,
      ...(project.recordingKnobs ?? {}),
    } as RecordingKnobs,
    exportKnobs: {
      ...global.exportKnobs,
      ...(project.exportKnobs ?? {}),
      audio: { ...global.exportKnobs.audio, ...(project.exportKnobs?.audio ?? {}) },
    } as ExportKnobs,
    version: LATEST_VERSION,
  };
}

export async function initOutputPrefs(): Promise<void> {
  let hydrated: PersistShape = { ...SEED };
  try {
    const store = await getStore();
    const raw = await store.get<PersistShape>(STORE_KEY);
    hydrated = migrate(raw);
    if (!raw || raw.version !== LATEST_VERSION) {
      await store.set(STORE_KEY, hydrated);
      await store.save();
    }
  } catch {
    // Storage unavailable — fall through with in-memory seed.
  }
  useOutputPrefsStore.getState().hydrate(hydrated);

  let timer: ReturnType<typeof setTimeout> | undefined;
  useOutputPrefsStore.subscribe((s) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const store = await getStore();
        const shape: PersistShape = {
          activePreset: s.activePreset,
          recordingKnobs: s.recordingKnobs,
          exportKnobs: s.exportKnobs,
          version: LATEST_VERSION,
        };
        await store.set(STORE_KEY, shape);
        await store.save();
      } catch {
        // best-effort write-back
      }
    }, 250);
  });
}

const PROJECT_FILE_REL = ".storycapture/output.json";

export async function loadProjectOverride(
  projectFolder: string,
): Promise<PartialPersist | null> {
  const path = `${projectFolder}/${PROJECT_FILE_REL}`;
  try {
    if (!(await exists(path))) return null;
    const text = await readTextFile(path);
    return JSON.parse(text) as PartialPersist;
  } catch {
    toast("Không đọc được tùy chọn riêng của dự án. Đang dùng mặc định chung.");
    return null;
  }
}

export async function saveProjectOverride(
  projectFolder: string,
  prefs: PartialPersist,
): Promise<void> {
  const dir = `${projectFolder}/.storycapture`;
  const path = `${projectFolder}/${PROJECT_FILE_REL}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeTextFile(path, JSON.stringify(prefs, null, 2));
  } catch (err) {
    toast.error("Không lưu được tùy chọn vào dự án.");
    throw err;
  }
}

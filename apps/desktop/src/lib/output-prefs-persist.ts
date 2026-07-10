import { mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

import { getStore, LATEST_VERSION, STORE_KEY } from "@/ipc/output-prefs";
import {
  DEFAULT_EXPORT_KNOBS,
  DEFAULT_RECORDING_PACING,
  type ExportKnobs,
  PRESET_BUNDLES,
  type PresetName,
  type RecordingKnobs,
  type RecordingPacingProfile,
  useOutputPrefsStore,
} from "@/state/output-prefs";

export interface PersistShape {
  activePreset: PresetName;
  recordingKnobs: RecordingKnobs;
  recordingPacing: RecordingPacingProfile;
  exportKnobs: ExportKnobs;
  version: typeof LATEST_VERSION;
}

const SEED: PersistShape = {
  activePreset: "Standard",
  recordingKnobs: PRESET_BUNDLES.Standard,
  recordingPacing: DEFAULT_RECORDING_PACING,
  exportKnobs: DEFAULT_EXPORT_KNOBS,
  version: LATEST_VERSION,
};

type PartialPersist = Partial<{
  activePreset: unknown;
  recordingKnobs: Partial<RecordingKnobs>;
  recordingPacing: unknown;
  exportKnobs: Partial<ExportKnobs> & { audio?: Partial<ExportKnobs["audio"]> };
  version: number;
}>;

function isPresetName(value: unknown): value is PresetName {
  return value === "Standard" || value === "Lossless" || value === "Custom";
}

function isRecordingQuality(value: unknown): value is RecordingKnobs["quality"] {
  return value === "high" || value === "lossless";
}

function currentRecordingKnobs(
  base: RecordingKnobs,
  override?: Partial<RecordingKnobs>,
): RecordingKnobs {
  const next = {
    ...base,
    ...(override ?? {}),
  } as RecordingKnobs;
  return {
    ...next,
    quality: isRecordingQuality(next.quality) ? next.quality : base.quality,
  };
}

function mergeExportKnobs(
  base: ExportKnobs,
  override?: Partial<ExportKnobs> & { audio?: Partial<ExportKnobs["audio"]> },
): ExportKnobs {
  const next = {
    ...base,
    ...(override ?? {}),
    audio: { ...base.audio, ...(override?.audio ?? {}) },
  } as ExportKnobs;
  if (next.hwEncoder === "none") {
    next.hwEncoder = "software";
  }
  return next;
}

export function migrate(raw: unknown): PersistShape {
  if (!raw || typeof raw !== "object") return { ...SEED };
  const r = raw as PartialPersist;
  const activePreset = isPresetName(r.activePreset) ? r.activePreset : SEED.activePreset;
  const recordingKnobs =
    activePreset !== "Custom"
      ? PRESET_BUNDLES[activePreset]
      : currentRecordingKnobs(SEED.recordingKnobs, r.recordingKnobs);
  const exportKnobs = mergeExportKnobs(SEED.exportKnobs, r.exportKnobs);
  return {
    activePreset,
    recordingKnobs,
    recordingPacing: DEFAULT_RECORDING_PACING,
    exportKnobs,
    version: LATEST_VERSION,
  };
}

export function resolveOverride(
  global: PersistShape,
  project: PartialPersist | null,
): PersistShape {
  if (!project) return global;
  const activePreset = isPresetName(project.activePreset)
    ? project.activePreset
    : global.activePreset;
  const hasExplicitPreset = isPresetName(project.activePreset);
  const recordingKnobs =
    hasExplicitPreset && activePreset !== "Custom"
      ? PRESET_BUNDLES[activePreset]
      : currentRecordingKnobs(global.recordingKnobs, project.recordingKnobs);
  const exportKnobs = mergeExportKnobs(global.exportKnobs, project.exportKnobs);
  return {
    activePreset,
    recordingKnobs,
    recordingPacing: DEFAULT_RECORDING_PACING,
    exportKnobs,
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
  let last = {
    activePreset: hydrated.activePreset,
    recordingKnobs: hydrated.recordingKnobs,
    recordingPacing: hydrated.recordingPacing,
    exportKnobs: hydrated.exportKnobs,
  };
  useOutputPrefsStore.subscribe((s) => {
    if (
      s.activePreset === last.activePreset &&
      s.recordingKnobs === last.recordingKnobs &&
      s.recordingPacing === last.recordingPacing &&
      s.exportKnobs === last.exportKnobs
    ) {
      return;
    }
    last = {
      activePreset: s.activePreset,
      recordingKnobs: s.recordingKnobs,
      recordingPacing: s.recordingPacing,
      exportKnobs: s.exportKnobs,
    };
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const store = await getStore();
        const shape: PersistShape = {
          activePreset: s.activePreset,
          recordingKnobs: s.recordingKnobs,
          recordingPacing: s.recordingPacing,
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

export async function loadProjectOverride(projectFolder: string): Promise<PartialPersist | null> {
  const path = `${projectFolder}/${PROJECT_FILE_REL}`;
  let text: string;
  try {
    text = await readTextFile(path);
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as PartialPersist;
  } catch {
    toast("Failed to read project-specific preferences. Falling back to defaults.");
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
    toast.error("Failed to save preferences to project.");
    throw err;
  }
}

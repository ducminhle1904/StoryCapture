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
  type RecordingPolicyPreference,
  useOutputPrefsStore,
} from "@/state/output-prefs";

export interface PersistShape {
  activePreset: PresetName;
  recordingPolicyPreference: RecordingPolicyPreference;
  recordingKnobs: RecordingKnobs;
  recordingPacing: RecordingPacingProfile;
  exportKnobs: ExportKnobs;
  version: typeof LATEST_VERSION;
}

const SEED: PersistShape = {
  activePreset: "Standard",
  recordingPolicyPreference: "best_effort",
  recordingKnobs: PRESET_BUNDLES.Standard,
  recordingPacing: DEFAULT_RECORDING_PACING,
  exportKnobs: DEFAULT_EXPORT_KNOBS,
  version: LATEST_VERSION,
};

type PartialPersist = Partial<{
  activePreset: unknown;
  recordingPolicyPreference: unknown;
  recordingDeliveryPolicy: unknown;
  recordingKnobs: Partial<RecordingKnobs>;
  recordingPacing: unknown;
  exportKnobs: Partial<ExportKnobs> & {
    audio?: Partial<ExportKnobs["audio"]>;
    x264Preset?: unknown;
    downscaleAlgo?: unknown;
  };
  version: number;
}>;

const SUPPORTED_EXPORT_ENCODERS = new Set<ExportKnobs["hwEncoder"]>([
  "auto",
  "software",
  "libx264",
  "h264-videotoolbox",
  "h264-nvenc",
  "h264-qsv",
  "h264-amf",
]);

const LEGACY_RESAMPLING_QUALITY = {
  lanczos: "high",
  bicubic: "balanced",
  bilinear: "fast",
} as const;

function isPresetName(value: unknown): value is PresetName {
  return value === "Standard" || value === "Lossless" || value === "Custom";
}

function isRecordingQuality(value: unknown): value is RecordingKnobs["quality"] {
  return value === "high" || value === "lossless";
}

function readRecordingPolicyPreference(
  value: unknown,
  legacyDeliveryPolicy?: unknown,
): RecordingPolicyPreference {
  if (
    value === "best_effort" ||
    value === "strict_local" ||
    value === "strict_certified"
  ) {
    return value;
  }
  if (legacyDeliveryPolicy === "strict") return "strict_certified";
  return "best_effort";
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
  override?: Partial<ExportKnobs> & {
    audio?: Partial<ExportKnobs["audio"]>;
    x264Preset?: unknown;
    downscaleAlgo?: unknown;
  },
): ExportKnobs {
  const { x264Preset, downscaleAlgo, ...canonicalOverride } = override ?? {};
  const next = {
    ...base,
    ...canonicalOverride,
    audio: { ...base.audio, ...(override?.audio ?? {}) },
  } as ExportKnobs;
  const legacyPreset = typeof x264Preset === "string" ? x264Preset : null;
  const legacyResampling =
    typeof downscaleAlgo === "string"
      ? (LEGACY_RESAMPLING_QUALITY[downscaleAlgo as keyof typeof LEGACY_RESAMPLING_QUALITY] ?? null)
      : null;
  const container = next.container === "webm" ? "webm" : "mp4";
  return {
    ...next,
    container,
    hwEncoder: SUPPORTED_EXPORT_ENCODERS.has(next.hwEncoder) ? next.hwEncoder : "auto",
    audio: container === "mp4" ? { ...DEFAULT_EXPORT_KNOBS.audio } : next.audio,
    encoderPreset:
      typeof override?.encoderPreset === "string"
        ? override.encoderPreset
        : (legacyPreset ?? base.encoderPreset),
    resamplingQuality:
      override?.resamplingQuality === "high" ||
      override?.resamplingQuality === "balanced" ||
      override?.resamplingQuality === "fast"
        ? override.resamplingQuality
        : (legacyResampling ?? base.resamplingQuality),
  };
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
    recordingPolicyPreference: readRecordingPolicyPreference(
      r.recordingPolicyPreference,
      r.recordingDeliveryPolicy,
    ),
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
    recordingPolicyPreference:
      project.recordingPolicyPreference === undefined &&
      project.recordingDeliveryPolicy === undefined
        ? global.recordingPolicyPreference
        : readRecordingPolicyPreference(
            project.recordingPolicyPreference,
            project.recordingDeliveryPolicy,
          ),
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
    recordingPolicyPreference: hydrated.recordingPolicyPreference,
    recordingKnobs: hydrated.recordingKnobs,
    recordingPacing: hydrated.recordingPacing,
    exportKnobs: hydrated.exportKnobs,
  };
  useOutputPrefsStore.subscribe((s) => {
    if (
      s.activePreset === last.activePreset &&
      s.recordingPolicyPreference === last.recordingPolicyPreference &&
      s.recordingKnobs === last.recordingKnobs &&
      s.recordingPacing === last.recordingPacing &&
      s.exportKnobs === last.exportKnobs
    ) {
      return;
    }
    last = {
      activePreset: s.activePreset,
      recordingPolicyPreference: s.recordingPolicyPreference,
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
          recordingPolicyPreference: s.recordingPolicyPreference,
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

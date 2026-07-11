import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Story } from "@/ipc/parse";

export type PolishRecipe = "dynamic" | "calm" | "minimal" | "dramatic";
export type PolishAutoZoom = "off" | "subtle" | "standard" | "strong";
export type PolishActionFocus = "off" | "subtle" | "standard" | "strong";
export type PolishCursorMode = "raw" | "smooth" | "hidden";
export type PolishCursorSkin = "mac-default" | "win-default" | "dark" | "light" | "big-arrow";
export type PolishZoom = "off" | "subtle" | "standard" | "strong";
export type PolishTransition =
  | "none"
  | "fade"
  | "fade-black"
  | "fade-white"
  | "dissolve"
  | "wipe-left"
  | "wipe-right"
  | "wipe-up"
  | "wipe-down"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "circle-open"
  | "circle-close";

export type PolishBackground =
  | { kind: "transparent" }
  | { kind: "gradient"; presetId: string }
  | { kind: "solid"; color: string };

export type PolishZoomTarget =
  | { kind: "cursor" }
  | { kind: "element"; selector: string }
  | { kind: "fixed-region"; topLeft: { x: number; y: number }; size: { x: number; y: number } };

export interface PolishCallout {
  text: string;
  pos: { x: number; y: number };
  sizePt: number;
  color: string;
  durationMs: number;
}

export interface PolishHighlight {
  enabled: boolean;
  radiusPx: number;
  color: string;
  durationMs: number;
}

export interface PolishSoundCue {
  path: string;
  label?: string;
  gain?: number;
  durationMs?: number;
}

export interface StoryPolishGlobal {
  recipe: PolishRecipe;
  autoZoom: PolishAutoZoom;
  actionFocus: PolishActionFocus;
  autoZoomDurationMs: number;
  cursor: PolishCursorMode;
  cursorSkin: PolishCursorSkin;
  cursorSizeScale: number;
  background: PolishBackground;
  bgm?: PolishSoundCue;
}

export interface StoryPolishScene {
  transitionOut?: PolishTransition;
  transitionDurationMs?: number;
}

export interface StoryPolishStep {
  zoom?: PolishZoom;
  zoomTarget?: PolishZoomTarget;
  zoomScale?: number;
  zoomDurationMs?: number;
  callout?: string | PolishCallout;
  highlight?: boolean | PolishHighlight;
  sfx?: PolishSoundCue;
}

export interface StoryPolishDoc {
  version: 2;
  global: StoryPolishGlobal;
  scenes: Record<string, StoryPolishScene>;
  steps: Record<string, StoryPolishStep>;
}

export interface PrunedPolishDoc {
  doc: StoryPolishDoc;
  changed: boolean;
  removedStepIds: string[];
  removedSceneNames: string[];
}

export const DEFAULT_POLISH_DOC: StoryPolishDoc = {
  version: 2,
  global: {
    recipe: "dynamic",
    autoZoom: "standard",
    actionFocus: "off",
    autoZoomDurationMs: 800,
    cursor: "smooth",
    cursorSkin: "mac-default",
    cursorSizeScale: 1,
    background: { kind: "gradient", presetId: "runway-dark" },
  },
  scenes: {},
  steps: {},
};

const POLISH_RECIPES: readonly PolishRecipe[] = ["dynamic", "calm", "minimal", "dramatic"];
const POLISH_AUTO_ZOOMS: readonly PolishAutoZoom[] = ["off", "subtle", "standard", "strong"];
const POLISH_ACTION_FOCUS: readonly PolishActionFocus[] = ["off", "subtle", "standard", "strong"];
const POLISH_CURSOR_MODES: readonly PolishCursorMode[] = ["raw", "smooth", "hidden"];
const POLISH_CURSOR_SKINS: readonly PolishCursorSkin[] = [
  "mac-default",
  "win-default",
  "dark",
  "light",
  "big-arrow",
];
const POLISH_ZOOMS: readonly PolishZoom[] = ["off", "subtle", "standard", "strong"];
const POLISH_TRANSITIONS: readonly PolishTransition[] = [
  "none",
  "fade",
  "fade-black",
  "fade-white",
  "dissolve",
  "wipe-left",
  "wipe-right",
  "wipe-up",
  "wipe-down",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "circle-open",
  "circle-close",
];

export function polishPathForStory(storyPath: string): string {
  return `${storyPath}.polish.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberOr(value: unknown, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function enumOr<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && options.includes(value as T) ? (value as T) : fallback;
}

function normalizeBackground(value: unknown): PolishBackground {
  if (isRecord(value)) {
    if (value.kind === "transparent") return { kind: "transparent" };
    if (value.kind === "solid") return { kind: "solid", color: stringOr(value.color, "#101218") };
    if (value.kind === "gradient") {
      return {
        kind: "gradient",
        presetId: stringOr(value.presetId ?? value.preset_id, "runway-dark"),
      };
    }
  }
  switch (value) {
    case "none":
      return { kind: "transparent" };
    case "minimal":
      return { kind: "gradient", presetId: "runway-light" };
    case "dark":
      return { kind: "solid", color: "#101218" };
    default:
      return DEFAULT_POLISH_DOC.global.background;
  }
}

function normalizeSoundCue(value: unknown): PolishSoundCue | undefined {
  if (!isRecord(value)) return undefined;
  const path = stringOr(value.path).trim();
  if (!path) return undefined;
  return {
    path,
    label: stringOr(value.label).trim() || undefined,
    gain: value.gain === undefined ? undefined : numberOr(value.gain, 1),
    durationMs: value.durationMs === undefined ? undefined : numberOr(value.durationMs, 1_000),
  };
}

function normalizeZoomTarget(value: unknown): PolishZoomTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "cursor") return { kind: "cursor" };
  if (value.kind === "element") return { kind: "element", selector: stringOr(value.selector) };
  if (value.kind === "fixed-region") {
    const topLeft = isRecord(value.topLeft)
      ? value.topLeft
      : isRecord(value.top_left)
        ? value.top_left
        : {};
    const size = isRecord(value.size) ? value.size : {};
    return {
      kind: "fixed-region",
      topLeft: { x: numberOr(topLeft.x, 0.25), y: numberOr(topLeft.y, 0.25) },
      size: { x: numberOr(size.x, 0.5), y: numberOr(size.y, 0.5) },
    };
  }
  return undefined;
}

function normalizeCallout(value: unknown): string | PolishCallout | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const text = stringOr(value.text).trim();
  if (!text) return undefined;
  const pos = isRecord(value.pos) ? value.pos : {};
  return {
    text,
    pos: { x: numberOr(pos.x, 0.5), y: numberOr(pos.y, 0.86) },
    sizePt: numberOr(value.sizePt, 24, 1),
    color: stringOr(value.color, "#ffffff"),
    durationMs: numberOr(value.durationMs, 1_600, 1),
  };
}

function normalizeHighlight(value: unknown): boolean | PolishHighlight | undefined {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;
  return {
    enabled: value.enabled !== false,
    radiusPx: numberOr(value.radiusPx, 56, 1),
    color: stringOr(value.color, "#ffffff"),
    durationMs: numberOr(value.durationMs, 700, 1),
  };
}

export function normalizePolishDoc(value: unknown): StoryPolishDoc {
  const raw = value && typeof value === "object" ? (value as Partial<StoryPolishDoc>) : {};
  const rawGlobal = raw.global && typeof raw.global === "object" ? raw.global : {};
  const rawScenes = raw.scenes && typeof raw.scenes === "object" ? raw.scenes : {};
  const rawSteps = raw.steps && typeof raw.steps === "object" ? raw.steps : {};
  const scenes: StoryPolishDoc["scenes"] = {};
  const steps: StoryPolishDoc["steps"] = {};

  for (const [sceneName, scene] of Object.entries(rawScenes)) {
    if (!isRecord(scene)) continue;
    scenes[sceneName] = {
      transitionOut:
        scene.transitionOut === undefined
          ? undefined
          : enumOr(scene.transitionOut, POLISH_TRANSITIONS, "none"),
      transitionDurationMs:
        scene.transitionDurationMs === undefined
          ? undefined
          : numberOr(scene.transitionDurationMs, 500, 1),
    };
  }

  for (const [stepId, step] of Object.entries(rawSteps)) {
    if (!isRecord(step)) continue;
    steps[stepId] = {
      zoom: step.zoom === undefined ? undefined : enumOr(step.zoom, POLISH_ZOOMS, "off"),
      zoomTarget: normalizeZoomTarget(step.zoomTarget),
      zoomScale: step.zoomScale === undefined ? undefined : numberOr(step.zoomScale, 1.35, 1),
      zoomDurationMs:
        step.zoomDurationMs === undefined ? undefined : numberOr(step.zoomDurationMs, 900, 1),
      callout: normalizeCallout(step.callout),
      highlight: normalizeHighlight(step.highlight),
      sfx: normalizeSoundCue(step.sfx),
    };
  }

  return {
    version: 2,
    global: {
      ...DEFAULT_POLISH_DOC.global,
      recipe: enumOr(
        (rawGlobal as { recipe?: unknown }).recipe,
        POLISH_RECIPES,
        DEFAULT_POLISH_DOC.global.recipe,
      ),
      autoZoom: enumOr(
        (rawGlobal as { autoZoom?: unknown }).autoZoom,
        POLISH_AUTO_ZOOMS,
        DEFAULT_POLISH_DOC.global.autoZoom,
      ),
      actionFocus: enumOr(
        (rawGlobal as { actionFocus?: unknown }).actionFocus,
        POLISH_ACTION_FOCUS,
        DEFAULT_POLISH_DOC.global.actionFocus,
      ),
      cursor: enumOr(
        (rawGlobal as { cursor?: unknown }).cursor,
        POLISH_CURSOR_MODES,
        DEFAULT_POLISH_DOC.global.cursor,
      ),
      cursorSkin: enumOr(
        (rawGlobal as { cursorSkin?: unknown }).cursorSkin,
        POLISH_CURSOR_SKINS,
        DEFAULT_POLISH_DOC.global.cursorSkin,
      ),
      background: normalizeBackground((rawGlobal as { background?: unknown }).background),
      bgm: normalizeSoundCue((rawGlobal as { bgm?: unknown }).bgm),
      autoZoomDurationMs: numberOr(
        (rawGlobal as { autoZoomDurationMs?: unknown }).autoZoomDurationMs,
        800,
        1,
      ),
      cursorSizeScale: numberOr(
        (rawGlobal as { cursorSizeScale?: unknown }).cursorSizeScale,
        1,
        0.1,
      ),
    },
    scenes,
    steps,
  };
}

export async function loadPolishDoc(storyPath: string | null | undefined): Promise<StoryPolishDoc> {
  if (!storyPath) return DEFAULT_POLISH_DOC;
  try {
    const polishPath = polishPathForStory(storyPath);
    if (!(await exists(polishPath))) return DEFAULT_POLISH_DOC;
    const text = await readTextFile(polishPath);
    return normalizePolishDoc(JSON.parse(text));
  } catch {
    return DEFAULT_POLISH_DOC;
  }
}

export async function savePolishDoc(
  storyPath: string | null | undefined,
  doc: StoryPolishDoc,
): Promise<void> {
  if (!storyPath) return;
  await writeTextFile(polishPathForStory(storyPath), `${JSON.stringify(doc, null, 2)}\n`);
}

export function setStepPolish(
  doc: StoryPolishDoc,
  stepId: string,
  patch: Partial<StoryPolishStep>,
): StoryPolishDoc {
  const nextStep = { ...(doc.steps[stepId] ?? {}), ...patch };
  if (!calloutText(nextStep.callout)) delete nextStep.callout;
  if (!highlightEnabled(nextStep.highlight)) delete nextStep.highlight;
  if (!nextStep.zoom || nextStep.zoom === "off") delete nextStep.zoom;
  if (!nextStep.sfx?.path.trim()) delete nextStep.sfx;
  const steps = { ...doc.steps };
  if (hasStepPolish(nextStep)) {
    steps[stepId] = nextStep;
  } else {
    delete steps[stepId];
  }
  return {
    ...doc,
    steps,
  };
}

export function setScenePolish(
  doc: StoryPolishDoc,
  sceneName: string,
  patch: Partial<StoryPolishScene>,
): StoryPolishDoc {
  const nextScene = { ...(doc.scenes[sceneName] ?? {}), ...patch };
  if (!nextScene.transitionOut || nextScene.transitionOut === "none") {
    delete nextScene.transitionOut;
  }
  const scenes = { ...doc.scenes };
  if (hasScenePolish(nextScene)) {
    scenes[sceneName] = nextScene;
  } else {
    delete scenes[sceneName];
  }
  return {
    ...doc,
    scenes,
  };
}

function hasStepPolish(value: StoryPolishStep): boolean {
  return Boolean(
    calloutText(value.callout) ||
      highlightEnabled(value.highlight) ||
      value.sfx?.path.trim() ||
      (value.zoom && value.zoom !== "off"),
  );
}

function hasScenePolish(value: StoryPolishScene): boolean {
  return Boolean(value.transitionOut && value.transitionOut !== "none");
}

export function calloutText(value: StoryPolishStep["callout"]): string {
  if (typeof value === "string") return value.trim();
  return value?.text.trim() ?? "";
}

export function highlightEnabled(value: StoryPolishStep["highlight"]): boolean {
  return typeof value === "boolean" ? value : Boolean(value?.enabled);
}

export function prunePolishDocForStory(doc: StoryPolishDoc, story: Story | null): PrunedPolishDoc {
  if (!story) {
    return { doc, changed: false, removedStepIds: [], removedSceneNames: [] };
  }
  const sceneNames = new Set(story.scenes.map((scene) => scene.name));
  const stepIds = new Set<string>();
  for (const scene of story.scenes) {
    for (const command of scene.commands) {
      if (command.step_id) stepIds.add(command.step_id);
    }
  }

  const steps: StoryPolishDoc["steps"] = {};
  const scenes: StoryPolishDoc["scenes"] = {};
  const removedStepIds: string[] = [];
  const removedSceneNames: string[] = [];

  for (const [stepId, value] of Object.entries(doc.steps)) {
    if (!stepIds.has(stepId) || !hasStepPolish(value)) {
      removedStepIds.push(stepId);
    } else {
      steps[stepId] = value;
    }
  }
  for (const [sceneName, value] of Object.entries(doc.scenes)) {
    if (!sceneNames.has(sceneName) || !hasScenePolish(value)) {
      removedSceneNames.push(sceneName);
    } else {
      scenes[sceneName] = value;
    }
  }

  const changed = removedStepIds.length > 0 || removedSceneNames.length > 0;
  return {
    doc: changed ? { ...doc, scenes, steps } : doc,
    changed,
    removedStepIds,
    removedSceneNames,
  };
}

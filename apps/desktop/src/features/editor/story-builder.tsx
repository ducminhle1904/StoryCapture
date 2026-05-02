import { ScBadge, ScButton, ScSegmented } from "@storycapture/ui";
import {
  ChevronDown,
  Code2,
  Focus,
  Megaphone,
  MousePointer2,
  Music2,
  Palette,
  Sparkles,
  Volume2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { SelectField } from "@/components/ui/select-field";
import { WorkflowRoadmapPanel } from "@/features/workflows/workflow-roadmap-panel";
import type { Command, Story } from "@/ipc/parse";
import {
  isPicked,
  type PickCandidate,
  type PickLocator,
  pickElementAuthor,
  pickerStampStepId,
  type TargetRecordDto,
} from "@/ipc/picker";
import type { WorkflowState } from "@/ipc/projects";
import {
  calloutText,
  highlightEnabled,
  type PolishActionFocus,
  type PolishAutoZoom,
  type PolishBackground,
  type PolishCallout,
  type PolishCursorMode,
  type PolishCursorSkin,
  type PolishHighlight,
  type PolishRecipe,
  type PolishSoundCue,
  type PolishTransition,
  type PolishZoom,
  type PolishZoomTarget,
  type StoryPolishDoc,
  setScenePolish,
  setStepPolish,
} from "./polish-sidecar";
import {
  cloneStoryWithStepId,
  commandSupportsPick,
  commandSupportsVisualFocus,
  formatEditableStory,
  patchCommand,
  patchSceneName,
  targetLabel,
  updateCommandTarget,
  updateCommandTargetFromPick,
} from "./story-ui-model";

interface StoryBuilderProps {
  story: Story | null;
  polish: StoryPolishDoc;
  simulatorActive: boolean;
  storySource: string;
  storyPath: string | null;
  streamId: string | null;
  onSourceChange: (source: string) => void;
  onSourceCommit: (source: string) => Promise<void>;
  onFlushSource?: () => void;
  onPolishChange: (doc: StoryPolishDoc) => void;
  workflowState: WorkflowState | null;
  onWorkflowChange: (workflow: WorkflowState) => void;
  onJumpToOffset: (offset: number) => void;
}

const recipeOptions = [
  { value: "dynamic", label: "Dynamic" },
  { value: "calm", label: "Calm" },
  { value: "minimal", label: "Minimal" },
  { value: "dramatic", label: "Dramatic" },
];

const zoomOptions = [
  { value: "off", label: "Zoom off" },
  { value: "subtle", label: "Subtle" },
  { value: "standard", label: "Standard" },
  { value: "strong", label: "Strong" },
];
const autoZoomOptions = [
  { value: "off", label: "Off" },
  { value: "subtle", label: "Subtle" },
  { value: "standard", label: "Standard" },
  { value: "strong", label: "Strong" },
];
const actionFocusOptions = autoZoomOptions;
const cursorModeOptions = [
  { value: "raw", label: "Raw" },
  { value: "smooth", label: "Smooth" },
  { value: "hidden", label: "Hidden" },
];
const zoomTargetOptions = [
  { value: "cursor", label: "Cursor" },
  { value: "element", label: "Element" },
  { value: "fixed-region", label: "Region" },
];

const transitionOptions: Array<{ value: PolishTransition; label: string }> = [
  { value: "none", label: "No transition" },
  { value: "fade", label: "Fade" },
  { value: "fade-black", label: "Fade black" },
  { value: "fade-white", label: "Fade white" },
  { value: "dissolve", label: "Dissolve" },
  { value: "wipe-left", label: "Wipe left" },
  { value: "wipe-right", label: "Wipe right" },
  { value: "wipe-up", label: "Wipe up" },
  { value: "wipe-down", label: "Wipe down" },
  { value: "slide-left", label: "Slide left" },
  { value: "slide-right", label: "Slide right" },
  { value: "slide-up", label: "Slide up" },
  { value: "slide-down", label: "Slide down" },
  { value: "circle-open", label: "Circle open" },
  { value: "circle-close", label: "Circle close" },
];

const cursorSkinOptions: Array<{ value: PolishCursorSkin; label: string }> = [
  { value: "mac-default", label: "Mac" },
  { value: "win-default", label: "Windows" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "big-arrow", label: "Big arrow" },
];

const backgroundOptions = [
  { value: "gradient:runway-dark", label: "Runway gradient" },
  { value: "gradient:runway-light", label: "Light gradient" },
  { value: "solid:#101218", label: "Dark solid" },
  { value: "transparent", label: "Transparent" },
] as const;

const fieldClass =
  "h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs text-[var(--sc-text)] outline-none focus:border-[var(--sc-accent-400)]";

function FieldLabel({ children }: { children: string }) {
  return (
    <span className="text-[10px] font-medium uppercase text-[var(--sc-text-4)]">{children}</span>
  );
}

function PolishGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
        {title}
      </legend>
      <div className="flex flex-wrap items-end gap-2">{children}</div>
    </fieldset>
  );
}

function LabeledControl({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

function polishChipClass(active: boolean): string {
  return [
    "inline-flex h-7 items-center gap-1.5 rounded-[var(--sc-r-sm)] border px-2 text-[11px] font-medium transition-[background-color,border-color,transform] active:scale-[0.98]",
    active
      ? "border-[var(--sc-accent-400)] bg-[var(--sc-accent-400)]/12 text-[var(--sc-text)]"
      : "border-[var(--sc-border)] bg-[var(--sc-surface)] text-[var(--sc-text-3)] hover:text-[var(--sc-text)]",
  ].join(" ");
}

function backgroundToValue(background: PolishBackground): string {
  if (background.kind === "transparent") return "transparent";
  if (background.kind === "solid") return `solid:${background.color}`;
  return `gradient:${background.presetId}`;
}

function backgroundFromValue(value: string): PolishBackground {
  if (value === "transparent") return { kind: "transparent" };
  const [kind, rest] = value.split(":");
  if (kind === "solid") return { kind: "solid", color: rest || "#101218" };
  return { kind: "gradient", presetId: rest || "runway-dark" };
}

function calloutObject(value: string | PolishCallout | undefined): PolishCallout {
  if (typeof value === "object" && value) return value;
  return {
    text: typeof value === "string" ? value : "",
    pos: { x: 0.5, y: 0.86 },
    sizePt: 24,
    color: "#ffffff",
    durationMs: 1_600,
  };
}

function highlightObject(value: boolean | PolishHighlight | undefined): PolishHighlight {
  if (typeof value === "object" && value) return value;
  return { enabled: Boolean(value), radiusPx: 56, color: "#ffffff", durationMs: 700 };
}

function soundCueObject(value: PolishSoundCue | undefined): PolishSoundCue {
  return value ?? { path: "", gain: 1, durationMs: 1_000 };
}

function zoomTargetObject(value: PolishZoomTarget | undefined): PolishZoomTarget {
  return value ?? { kind: "cursor" };
}

function commandTitle(command: Command): string {
  switch (command.verb) {
    case "wait-for":
      return "Wait for";
    default:
      return command.verb.charAt(0).toUpperCase() + command.verb.slice(1);
  }
}

function commandSummary(command: Command): string {
  switch (command.verb) {
    case "navigate":
      return command.url;
    case "click":
    case "hover":
    case "assert":
      return targetLabel(command.target);
    case "type":
      return `${targetLabel(command.target)} -> ${command.text}`;
    case "drag":
      return `${targetLabel(command.from)} -> ${targetLabel(command.to)}`;
    case "select":
      return `${targetLabel(command.target)} = ${command.value}`;
    case "upload":
      return `${targetLabel(command.target)} <- ${command.path}`;
    case "wait":
      return `${command.duration_ms}ms`;
    case "wait-for":
      return `${targetLabel(command.target)}${command.timeout_ms ? ` / ${command.timeout_ms}ms` : ""}`;
    case "screenshot":
      return command.name;
    case "scroll":
      return `${command.direction}${command.amount == null ? "" : ` ${command.amount}`}`;
    case "pause":
      return "Pause automation";
  }
}

function primaryEditableValue(command: Command): string {
  switch (command.verb) {
    case "navigate":
      return command.url;
    case "type":
      return command.text;
    case "select":
      return command.value;
    case "upload":
      return command.path;
    case "screenshot":
      return command.name;
    case "click":
    case "hover":
    case "assert":
    case "wait-for":
      return command.target.kind === "role" ? command.target.value.name : command.target.value;
    case "wait":
      return String(command.duration_ms);
    case "scroll":
      return command.amount == null ? "" : String(command.amount);
    case "drag":
    case "pause":
      return "";
  }
}

function targetRecordFromLocator(locator: PickLocator | PickCandidate): TargetRecordDto | null {
  switch (locator.kind) {
    case "testid":
    case "label":
    case "text_exact":
    case "selector":
    case "aria":
    case "text":
      return typeof locator.value === "string"
        ? { kind: locator.kind, value: locator.value, nth: locator.nth }
        : null;
    case "role":
      if (
        locator.value &&
        typeof locator.value === "object" &&
        "role" in locator.value &&
        "name" in locator.value &&
        typeof locator.value.role === "string" &&
        typeof locator.value.name === "string"
      ) {
        return {
          kind: "role",
          value: { role: locator.value.role, name: locator.value.name },
          nth: locator.nth,
        };
      }
      return null;
    default:
      return null;
  }
}

export function StoryBuilder({
  story,
  polish,
  simulatorActive,
  storySource,
  storyPath,
  streamId,
  onSourceChange,
  onSourceCommit,
  onFlushSource,
  onPolishChange,
  workflowState,
  onWorkflowChange,
  onJumpToOffset,
}: StoryBuilderProps) {
  const [pickingKey, setPickingKey] = useState<string | null>(null);
  const [expandedPolishKey, setExpandedPolishKey] = useState<string | null>(null);
  const [intentExpanded, setIntentExpanded] = useState(true);

  if (!story) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--sc-text-3)]">
        Switch to Code mode to fix parse errors before using UI mode.
      </div>
    );
  }

  const updateGlobal = (
    patch: Partial<{
      recipe: PolishRecipe;
      autoZoom: PolishAutoZoom;
      actionFocus: PolishActionFocus;
      autoZoomDurationMs: number;
      cursor: PolishCursorMode;
      cursorSkin: PolishCursorSkin;
      cursorSizeScale: number;
      background: PolishBackground;
      bgm?: PolishSoundCue;
    }>,
  ) => {
    if (simulatorActive) return;
    onPolishChange({ ...polish, global: { ...polish.global, ...patch } });
  };

  const updateSourceCommand = (
    sceneIndex: number,
    commandIndex: number,
    command: Command,
    value: string,
  ) => {
    let patch: Partial<Command> = {};
    switch (command.verb) {
      case "navigate":
        patch = { url: value };
        break;
      case "type":
        patch = { text: value };
        break;
      case "select":
        patch = { value };
        break;
      case "upload":
        patch = { path: value };
        break;
      case "screenshot":
        patch = { name: value };
        break;
      case "wait":
        patch = { duration_ms: Math.max(0, Number(value) || 0) };
        break;
      case "scroll":
        patch = { amount: value.trim() ? Number(value) || 0 : null };
        break;
      case "click":
      case "hover":
      case "assert":
      case "wait-for":
        patch = updateCommandTarget(command, value) as Partial<Command>;
        break;
      case "drag":
      case "pause":
        return;
    }
    onSourceChange(formatEditableStory(patchCommand(story, sceneIndex, commandIndex, patch)));
  };

  const updateStepPolish = (
    sceneIndex: number,
    commandIndex: number,
    patch: Partial<{
      zoom: PolishZoom;
      zoomTarget: PolishZoomTarget;
      zoomScale: number;
      zoomDurationMs: number;
      callout: string | PolishCallout;
      highlight: boolean | PolishHighlight;
      sfx: PolishSoundCue;
    }>,
  ) => {
    const { story: nextStory, stepId } = cloneStoryWithStepId(story, sceneIndex, commandIndex);
    if (!story.scenes[sceneIndex]?.commands[commandIndex]?.step_id) {
      onSourceChange(formatEditableStory(nextStory));
    }
    onPolishChange(setStepPolish(polish, stepId, patch));
  };

  const pickTarget = async (sceneIndex: number, commandIndex: number, command: Command) => {
    if (simulatorActive || !commandSupportsPick(command)) return;
    if (!streamId) {
      toast.warning("Enable Live Preview first — Pick needs an author session");
      return;
    }
    const pickKey = `${sceneIndex}-${commandIndex}`;
    setPickingKey(pickKey);
    try {
      const { story: storyWithId } = cloneStoryWithStepId(story, sceneIndex, commandIndex);
      const commandWithId = storyWithId.scenes[sceneIndex]?.commands[commandIndex] ?? command;
      if (!command.step_id) {
        await onSourceCommit(formatEditableStory(storyWithId));
      }
      const result = await pickElementAuthor({
        streamId,
        storySrc: storySource,
        cursorLine: command.span.line,
        timeoutMs: 60_000,
      });
      if (!isPicked(result)) {
        if (result.reason !== "user-cancel") toast.info(`Picking ended: ${result.reason}`);
        return;
      }

      const patched = patchCommand(
        storyWithId,
        sceneIndex,
        commandIndex,
        updateCommandTargetFromPick(commandWithId, result.locator),
      );
      await onSourceCommit(formatEditableStory(patched));

      if (storyPath) {
        const primary = targetRecordFromLocator(result.locator);
        if (primary) {
          await pickerStampStepId({
            storyPath,
            lineOffset: command.span.line,
            primary,
            fallbacks: result.candidates
              .map((candidate) => targetRecordFromLocator(candidate))
              .filter((candidate): candidate is TargetRecordDto => Boolean(candidate)),
          });
        }
      }
      toast.success("Updated target");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPickingKey(null);
    }
  };

  return (
    <form
      aria-label="Story builder"
      className="flex h-full flex-col overflow-hidden bg-[var(--sc-surface)]"
      onSubmit={(event) => event.preventDefault()}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          onFlushSource?.();
        }
      }}
    >
      {workflowState ? (
        <WorkflowRoadmapPanel
          workflow={workflowState}
          disabled={simulatorActive}
          onChange={onWorkflowChange}
        />
      ) : null}
      <div className="shrink-0 border-b border-[var(--sc-border-2)] bg-[var(--sc-chrome)]">
        <div className="flex h-10 items-center gap-2 px-3">
          <Sparkles size={14} aria-hidden="true" className="text-[var(--sc-accent-400)]" />
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] font-semibold uppercase text-[var(--sc-text-3)] transition hover:text-[var(--sc-text)]"
            aria-expanded={intentExpanded}
            onClick={() => setIntentExpanded((value) => !value)}
          >
            <span className="truncate">Post-production intent</span>
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={`transition-transform ${intentExpanded ? "rotate-180" : ""}`}
            />
          </button>
          <span className="rounded-full border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 py-0.5 font-mono text-[10px] uppercase text-[var(--sc-text-4)]">
            {polish.global.recipe}
          </span>
        </div>
        {intentExpanded ? (
          <div className="grid grid-cols-1 gap-3 px-3 pb-3 lg:grid-cols-2">
            <PolishGroup title="Style">
              <ScSegmented
                size="sm"
                value={polish.global.recipe}
                aria-label="Polish recipe"
                disabled={simulatorActive}
                options={recipeOptions}
                onValueChange={(value) => updateGlobal({ recipe: value as PolishRecipe })}
              />
            </PolishGroup>

            <PolishGroup title="Motion">
              <LabeledControl label="Auto zoom" className="min-w-[140px] flex-1">
                <SelectField
                  value={polish.global.autoZoom}
                  disabled={simulatorActive}
                  options={autoZoomOptions}
                  onValueChange={(value) => updateGlobal({ autoZoom: value as PolishAutoZoom })}
                  aria-label="Auto zoom"
                />
              </LabeledControl>
              <LabeledControl label="Action focus" className="min-w-[140px] flex-1">
                <SelectField
                  value={polish.global.actionFocus}
                  disabled={simulatorActive}
                  options={actionFocusOptions}
                  onValueChange={(value) =>
                    updateGlobal({ actionFocus: value as PolishActionFocus })
                  }
                  aria-label="Action focus"
                />
              </LabeledControl>
              <LabeledControl label="Duration" className="w-24">
                <input
                  className={fieldClass}
                  type="number"
                  min={200}
                  step={100}
                  value={polish.global.autoZoomDurationMs}
                  disabled={simulatorActive}
                  aria-label="Auto zoom duration"
                  onChange={(event) =>
                    updateGlobal({
                      autoZoomDurationMs: Math.max(200, Number(event.target.value) || 800),
                    })
                  }
                />
              </LabeledControl>
            </PolishGroup>

            <PolishGroup title="Cursor">
              <LabeledControl label="Mode" className="min-w-[120px] flex-1">
                <SelectField
                  value={polish.global.cursor}
                  disabled={simulatorActive}
                  options={cursorModeOptions}
                  onValueChange={(value) => updateGlobal({ cursor: value as PolishCursorMode })}
                  aria-label="Cursor mode"
                />
              </LabeledControl>
              <LabeledControl label="Skin" className="min-w-[120px] flex-1">
                <SelectField
                  value={polish.global.cursorSkin}
                  disabled={simulatorActive || polish.global.cursor === "hidden"}
                  options={cursorSkinOptions}
                  onValueChange={(value) => updateGlobal({ cursorSkin: value as PolishCursorSkin })}
                  aria-label="Cursor skin"
                />
              </LabeledControl>
              <LabeledControl label="Size" className="w-20">
                <input
                  className={fieldClass}
                  type="number"
                  min={0.5}
                  max={2.5}
                  step={0.1}
                  value={polish.global.cursorSizeScale}
                  disabled={simulatorActive || polish.global.cursor === "hidden"}
                  aria-label="Cursor size"
                  onChange={(event) =>
                    updateGlobal({
                      cursorSizeScale: Math.max(0.5, Number(event.target.value) || 1),
                    })
                  }
                />
              </LabeledControl>
            </PolishGroup>

            <PolishGroup title="Canvas & Audio">
              <LabeledControl label="Background" className="min-w-[150px] flex-1">
                <SelectField
                  value={backgroundToValue(polish.global.background)}
                  disabled={simulatorActive}
                  options={backgroundOptions}
                  onValueChange={(value) =>
                    updateGlobal({ background: backgroundFromValue(value) })
                  }
                  aria-label="Background"
                />
              </LabeledControl>
              <LabeledControl label="BGM asset" className="min-w-[180px] flex-1">
                <input
                  className={fieldClass}
                  value={polish.global.bgm?.path ?? ""}
                  disabled={simulatorActive}
                  placeholder="Choose or paste audio path"
                  aria-label="Background music path"
                  onChange={(event) =>
                    updateGlobal({
                      bgm: event.target.value.trim()
                        ? {
                            ...soundCueObject(polish.global.bgm),
                            path: event.target.value,
                            gain: 0.35,
                          }
                        : undefined,
                    })
                  }
                />
              </LabeledControl>
            </PolishGroup>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
        {story.scenes.map((scene, sceneIndex) => {
          const scenePolish = polish.scenes[scene.name] ?? {};
          return (
            <section
              key={`${scene.name}-${scene.span.start}`}
              className="mb-5 border-b border-[var(--sc-border-2)] pb-5 last:border-b-0"
            >
              <div className="mb-3 flex items-center gap-2">
                <input
                  className="min-w-0 flex-1 bg-transparent text-base font-semibold text-[var(--sc-text)] outline-none"
                  value={scene.name}
                  disabled={simulatorActive}
                  onChange={(event) =>
                    onSourceChange(
                      formatEditableStory(patchSceneName(story, sceneIndex, event.target.value)),
                    )
                  }
                  aria-label={`Scene ${sceneIndex + 1} name`}
                />
                <LabeledControl label="Transition" className="w-40">
                  <SelectField
                    value={scenePolish.transitionOut ?? "none"}
                    disabled={simulatorActive}
                    options={transitionOptions}
                    onValueChange={(value) =>
                      onPolishChange(
                        setScenePolish(polish, scene.name, {
                          transitionOut: value as PolishTransition,
                        }),
                      )
                    }
                    aria-label={`Transition for ${scene.name}`}
                  />
                </LabeledControl>
                <LabeledControl label="Duration" className="w-24">
                  <input
                    className={fieldClass}
                    type="number"
                    min={100}
                    step={100}
                    value={scenePolish.transitionDurationMs ?? 500}
                    disabled={simulatorActive || !scenePolish.transitionOut}
                    aria-label={`Transition duration for ${scene.name}`}
                    onChange={(event) =>
                      onPolishChange(
                        setScenePolish(polish, scene.name, {
                          transitionDurationMs: Math.max(100, Number(event.target.value) || 500),
                        }),
                      )
                    }
                  />
                </LabeledControl>
              </div>

              <div className="space-y-2">
                {scene.commands.map((command, commandIndex) => {
                  const stepPolish = command.step_id ? polish.steps[command.step_id] : undefined;
                  const supportsPick = commandSupportsPick(command);
                  const supportsVisualFocus = commandSupportsVisualFocus(command);
                  const pickKey = `${sceneIndex}-${commandIndex}`;
                  const callout = calloutObject(stepPolish?.callout);
                  const highlight = highlightObject(stepPolish?.highlight);
                  const sfx = soundCueObject(stepPolish?.sfx);
                  const zoomTarget = zoomTargetObject(stepPolish?.zoomTarget);
                  const zoomEnabled = Boolean(stepPolish?.zoom && stepPolish.zoom !== "off");
                  const calloutValue = calloutText(stepPolish?.callout);
                  const highlightActive = highlightEnabled(stepPolish?.highlight);
                  const sfxActive = Boolean(stepPolish?.sfx?.path.trim());
                  const stepKey = command.step_id ?? `${sceneIndex}-${commandIndex}`;
                  const polishOpen = expandedPolishKey === stepKey;
                  return (
                    <article
                      key={`${command.span.start}-${command.verb}`}
                      className="rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] p-3"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <ScBadge tone="muted">{commandTitle(command)}</ScBadge>
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-xs text-[var(--sc-text-3)] hover:text-[var(--sc-text)]"
                          onClick={() => onJumpToOffset(command.span.start)}
                        >
                          {commandSummary(command)}
                        </button>
                        <Code2 size={12} aria-hidden="true" className="text-[var(--sc-text-4)]" />
                      </div>

                      <div
                        className={
                          supportsPick
                            ? "grid grid-cols-[1fr_auto] items-center gap-2"
                            : "grid grid-cols-1"
                        }
                      >
                        <input
                          className="h-9 min-w-0 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-sm text-[var(--sc-text)] outline-none focus:border-[var(--sc-accent-400)]"
                          value={primaryEditableValue(command)}
                          disabled={
                            simulatorActive || command.verb === "drag" || command.verb === "pause"
                          }
                          onChange={(event) =>
                            updateSourceCommand(
                              sceneIndex,
                              commandIndex,
                              command,
                              event.target.value,
                            )
                          }
                          aria-label={`${commandTitle(command)} value`}
                        />
                        {supportsPick ? (
                          <ScButton
                            size="sm"
                            variant="ghost"
                            disabled={simulatorActive || pickingKey === pickKey}
                            icon={<MousePointer2 size={12} aria-hidden="true" />}
                            title="Pick target from preview"
                            className="h-9 self-center"
                            onClick={() => pickTarget(sceneIndex, commandIndex, command)}
                          >
                            {pickingKey === pickKey ? "Picking" : "Pick"}
                          </ScButton>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {supportsVisualFocus ? (
                          <button
                            type="button"
                            className={polishChipClass(zoomEnabled)}
                            onClick={() =>
                              setExpandedPolishKey((current) =>
                                current === stepKey ? null : stepKey,
                              )
                            }
                          >
                            <Focus size={12} aria-hidden="true" />
                            Zoom {zoomEnabled ? stepPolish?.zoom : "off"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={polishChipClass(Boolean(calloutValue))}
                          onClick={() =>
                            setExpandedPolishKey((current) =>
                              current === stepKey ? null : stepKey,
                            )
                          }
                        >
                          <Megaphone size={12} aria-hidden="true" />
                          {calloutValue ? "Callout" : "No callout"}
                        </button>
                        {supportsVisualFocus ? (
                          <button
                            type="button"
                            className={polishChipClass(highlightActive)}
                            onClick={() =>
                              updateStepPolish(sceneIndex, commandIndex, {
                                highlight: { ...highlight, enabled: !highlightActive },
                              })
                            }
                          >
                            <Palette size={12} aria-hidden="true" />
                            Highlight {highlightActive ? "on" : "off"}
                          </button>
                        ) : null}
                        {supportsVisualFocus ? (
                          <button
                            type="button"
                            className={polishChipClass(sfxActive)}
                            onClick={() =>
                              setExpandedPolishKey((current) =>
                                current === stepKey ? null : stepKey,
                              )
                            }
                          >
                            <Volume2 size={12} aria-hidden="true" />
                            {sfxActive ? "SFX" : "No SFX"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="ml-auto inline-flex h-7 items-center gap-1 rounded-[var(--sc-r-sm)] px-2 text-[11px] text-[var(--sc-text-3)] transition hover:bg-[var(--sc-surface)] hover:text-[var(--sc-text)] active:scale-[0.98]"
                          aria-expanded={polishOpen}
                          onClick={() =>
                            setExpandedPolishKey((current) =>
                              current === stepKey ? null : stepKey,
                            )
                          }
                        >
                          Polish
                          <ChevronDown
                            size={12}
                            aria-hidden="true"
                            className={`transition-transform ${polishOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                      </div>

                      {polishOpen ? (
                        <div className="mt-3 border-t border-[var(--sc-border-2)] pt-3">
                          <div
                            className={
                              supportsVisualFocus
                                ? "grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(120px,0.9fr)_minmax(300px,1.35fr)_minmax(220px,1fr)]"
                                : "grid grid-cols-1"
                            }
                          >
                            {supportsVisualFocus ? (
                              <fieldset className="border-0 p-0">
                                <legend className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                                  <Focus size={11} aria-hidden="true" /> Focus
                                </legend>
                                <div className="flex flex-wrap items-end gap-2">
                                  <LabeledControl label="Zoom" className="w-32">
                                    <SelectField
                                      value={stepPolish?.zoom ?? "off"}
                                      disabled={simulatorActive}
                                      options={zoomOptions}
                                      onValueChange={(value) =>
                                        updateStepPolish(sceneIndex, commandIndex, {
                                          zoom: value as PolishZoom,
                                        })
                                      }
                                      aria-label={`${commandTitle(command)} zoom`}
                                    />
                                  </LabeledControl>
                                  {zoomEnabled ? (
                                    <LabeledControl label="Target" className="w-36">
                                      <SelectField
                                        value={zoomTarget.kind}
                                        disabled={simulatorActive}
                                        options={zoomTargetOptions}
                                        onValueChange={(value) => {
                                          const kind = value as PolishZoomTarget["kind"];
                                          updateStepPolish(sceneIndex, commandIndex, {
                                            zoomTarget:
                                              kind === "element"
                                                ? { kind, selector: "" }
                                                : kind === "fixed-region"
                                                  ? {
                                                      kind,
                                                      topLeft: { x: 0.25, y: 0.25 },
                                                      size: { x: 0.5, y: 0.5 },
                                                    }
                                                  : { kind: "cursor" },
                                          });
                                        }}
                                        aria-label={`${commandTitle(command)} zoom target`}
                                      />
                                    </LabeledControl>
                                  ) : null}
                                  {zoomEnabled && zoomTarget.kind === "element" ? (
                                    <LabeledControl
                                      label="Selector"
                                      className="min-w-[180px] flex-1"
                                    >
                                      <input
                                        className={fieldClass}
                                        value={zoomTarget.selector}
                                        disabled={simulatorActive}
                                        placeholder="CSS selector"
                                        onChange={(event) =>
                                          updateStepPolish(sceneIndex, commandIndex, {
                                            zoomTarget: {
                                              kind: "element",
                                              selector: event.target.value,
                                            },
                                          })
                                        }
                                        aria-label={`${commandTitle(command)} zoom selector`}
                                      />
                                    </LabeledControl>
                                  ) : null}
                                </div>
                              </fieldset>
                            ) : null}

                            <fieldset
                              className={
                                supportsVisualFocus
                                  ? "min-w-0 border-0 p-0"
                                  : "min-w-0 border-0 p-0"
                              }
                            >
                              <legend className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                                <Megaphone size={11} aria-hidden="true" /> Callout
                              </legend>
                              <div
                                className={
                                  supportsVisualFocus
                                    ? "grid grid-cols-[minmax(180px,1fr)_80px_56px] items-end gap-3"
                                    : "grid grid-cols-[minmax(220px,1fr)_80px_56px] items-end gap-3"
                                }
                              >
                                <LabeledControl label="Text" className="min-w-0">
                                  <input
                                    className={fieldClass}
                                    value={calloutValue}
                                    disabled={simulatorActive}
                                    placeholder="Add callout text"
                                    onChange={(event) =>
                                      updateStepPolish(sceneIndex, commandIndex, {
                                        callout: { ...callout, text: event.target.value },
                                      })
                                    }
                                    aria-label={`${commandTitle(command)} callout`}
                                  />
                                </LabeledControl>
                                <LabeledControl label="Size">
                                  <input
                                    className={fieldClass}
                                    type="number"
                                    min={12}
                                    max={72}
                                    step={1}
                                    value={callout.sizePt}
                                    disabled={simulatorActive}
                                    aria-label={`${commandTitle(command)} callout size`}
                                    onChange={(event) =>
                                      updateStepPolish(sceneIndex, commandIndex, {
                                        callout: {
                                          ...callout,
                                          sizePt: Math.max(12, Number(event.target.value) || 24),
                                        },
                                      })
                                    }
                                  />
                                </LabeledControl>
                                <LabeledControl label="Color">
                                  <input
                                    className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-1"
                                    type="color"
                                    value={callout.color}
                                    disabled={simulatorActive}
                                    aria-label={`${commandTitle(command)} callout color`}
                                    onChange={(event) =>
                                      updateStepPolish(sceneIndex, commandIndex, {
                                        callout: { ...callout, color: event.target.value },
                                      })
                                    }
                                  />
                                </LabeledControl>
                              </div>
                            </fieldset>

                            {supportsVisualFocus ? (
                              <fieldset className="border-0 p-0">
                                <legend className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sc-text-4)]">
                                  <Music2 size={11} aria-hidden="true" /> Effects
                                </legend>
                                <div className="grid grid-cols-1 items-end gap-3">
                                  <LabeledControl label="Highlight" className="min-w-0">
                                    <label className="inline-flex h-8 items-center gap-2 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] px-2 text-xs text-[var(--sc-text-2)]">
                                      <input
                                        type="checkbox"
                                        checked={highlightActive}
                                        disabled={simulatorActive}
                                        onChange={(event) =>
                                          updateStepPolish(sceneIndex, commandIndex, {
                                            highlight: {
                                              ...highlight,
                                              enabled: event.target.checked,
                                            },
                                          })
                                        }
                                      />
                                      Enabled
                                    </label>
                                  </LabeledControl>
                                  <LabeledControl label="SFX asset" className="min-w-0">
                                    <input
                                      className={fieldClass}
                                      value={sfx.path}
                                      disabled={simulatorActive}
                                      placeholder="Choose or paste audio path"
                                      onChange={(event) =>
                                        updateStepPolish(sceneIndex, commandIndex, {
                                          sfx: event.target.value.trim()
                                            ? { ...sfx, path: event.target.value }
                                            : undefined,
                                        })
                                      }
                                      aria-label={`${commandTitle(command)} sound effect path`}
                                    />
                                  </LabeledControl>
                                </div>
                              </fieldset>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </form>
  );
}

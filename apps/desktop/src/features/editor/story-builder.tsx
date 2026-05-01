import { ScBadge, ScButton, ScSegmented } from "@storycapture/ui";
import { ArrowRight, Code2, MousePointer2, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { Command, Story } from "@/ipc/parse";
import {
  isPicked,
  type PickCandidate,
  type PickLocator,
  pickElementAuthor,
  pickerStampStepId,
  type TargetRecordDto,
} from "@/ipc/picker";
import {
  calloutText,
  highlightEnabled,
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
  onJumpToOffset,
}: StoryBuilderProps) {
  const [pickingKey, setPickingKey] = useState<string | null>(null);

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
      <div className="border-b border-[var(--sc-border-2)] bg-[var(--sc-chrome)] p-3">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles size={14} aria-hidden="true" className="text-[var(--sc-accent-400)]" />
          <span className="text-[12px] font-semibold uppercase text-[var(--sc-text-3)]">
            Polish recipe
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ScSegmented
            size="sm"
            value={polish.global.recipe}
            aria-label="Polish recipe"
            disabled={simulatorActive}
            options={recipeOptions}
            onValueChange={(value) => updateGlobal({ recipe: value as PolishRecipe })}
          />
          <select
            className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
            value={polish.global.autoZoom}
            disabled={simulatorActive}
            onChange={(event) => updateGlobal({ autoZoom: event.target.value as PolishAutoZoom })}
          >
            <option value="off">Auto zoom off</option>
            <option value="subtle">Auto zoom subtle</option>
            <option value="standard">Auto zoom standard</option>
            <option value="strong">Auto zoom strong</option>
          </select>
          <select
            className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
            value={polish.global.cursor}
            disabled={simulatorActive}
            onChange={(event) => updateGlobal({ cursor: event.target.value as PolishCursorMode })}
          >
            <option value="raw">Raw cursor</option>
            <option value="smooth">Smooth cursor</option>
            <option value="hidden">Hide raw cursor</option>
          </select>
          <input
            className="h-8 w-24 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
            type="number"
            min={200}
            step={100}
            value={polish.global.autoZoomDurationMs}
            disabled={simulatorActive}
            aria-label="Auto zoom duration"
            onChange={(event) =>
              updateGlobal({ autoZoomDurationMs: Math.max(200, Number(event.target.value) || 800) })
            }
          />
          <select
            className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
            value={polish.global.cursorSkin}
            disabled={simulatorActive || polish.global.cursor === "hidden"}
            onChange={(event) =>
              updateGlobal({ cursorSkin: event.target.value as PolishCursorSkin })
            }
          >
            {cursorSkinOptions.map((option) => (
              <option key={option.value} value={option.value}>
                Cursor {option.label}
              </option>
            ))}
          </select>
          <input
            className="h-8 w-20 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
            type="number"
            min={0.5}
            max={2.5}
            step={0.1}
            value={polish.global.cursorSizeScale}
            disabled={simulatorActive || polish.global.cursor === "hidden"}
            aria-label="Cursor size"
            onChange={(event) =>
              updateGlobal({ cursorSizeScale: Math.max(0.5, Number(event.target.value) || 1) })
            }
          />
          <select
            className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
            value={backgroundToValue(polish.global.background)}
            disabled={simulatorActive}
            onChange={(event) =>
              updateGlobal({ background: backgroundFromValue(event.target.value) })
            }
          >
            {backgroundOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            className="h-8 min-w-[220px] flex-1 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs text-[var(--sc-text)] outline-none focus:border-[var(--sc-accent-400)]"
            value={polish.global.bgm?.path ?? ""}
            disabled={simulatorActive}
            placeholder="BGM path"
            aria-label="Background music path"
            onChange={(event) =>
              updateGlobal({
                bgm: event.target.value.trim()
                  ? { ...soundCueObject(polish.global.bgm), path: event.target.value, gain: 0.35 }
                  : undefined,
              })
            }
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
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
                <select
                  className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
                  value={scenePolish.transitionOut ?? "none"}
                  disabled={simulatorActive}
                  onChange={(event) =>
                    onPolishChange(
                      setScenePolish(polish, scene.name, {
                        transitionOut: event.target.value as PolishTransition,
                      }),
                    )
                  }
                  aria-label={`Transition for ${scene.name}`}
                >
                  {transitionOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  className="h-8 w-24 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
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
                          supportsPick ? "grid grid-cols-[1fr_auto] gap-2" : "grid grid-cols-1"
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
                            onClick={() => pickTarget(sceneIndex, commandIndex, command)}
                          >
                            {pickingKey === pickKey ? "Picking" : "Pick"}
                          </ScButton>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {supportsVisualFocus ? (
                          <select
                            className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
                            value={stepPolish?.zoom ?? "off"}
                            disabled={simulatorActive}
                            onChange={(event) =>
                              updateStepPolish(sceneIndex, commandIndex, {
                                zoom: event.target.value as PolishZoom,
                              })
                            }
                            aria-label={`${commandTitle(command)} zoom`}
                          >
                            {zoomOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {supportsVisualFocus && zoomEnabled ? (
                          <select
                            className="h-8 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
                            value={zoomTarget.kind}
                            disabled={simulatorActive}
                            onChange={(event) => {
                              const kind = event.target.value as PolishZoomTarget["kind"];
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
                          >
                            <option value="cursor">Cursor target</option>
                            <option value="element">Element target</option>
                            <option value="fixed-region">Region target</option>
                          </select>
                        ) : null}
                        {supportsVisualFocus && zoomEnabled && zoomTarget.kind === "element" ? (
                          <input
                            className="h-8 min-w-[160px] rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs text-[var(--sc-text)] outline-none focus:border-[var(--sc-accent-400)]"
                            value={zoomTarget.selector}
                            disabled={simulatorActive}
                            placeholder="Zoom selector"
                            onChange={(event) =>
                              updateStepPolish(sceneIndex, commandIndex, {
                                zoomTarget: { kind: "element", selector: event.target.value },
                              })
                            }
                            aria-label={`${commandTitle(command)} zoom selector`}
                          />
                        ) : null}
                        <input
                          className="h-8 min-w-[180px] flex-1 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs text-[var(--sc-text)] outline-none focus:border-[var(--sc-accent-400)]"
                          value={calloutText(stepPolish?.callout)}
                          disabled={simulatorActive}
                          placeholder="Callout text"
                          onChange={(event) =>
                            updateStepPolish(sceneIndex, commandIndex, {
                              callout: { ...callout, text: event.target.value },
                            })
                          }
                          aria-label={`${commandTitle(command)} callout`}
                        />
                        <input
                          className="h-8 w-20 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs"
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
                        <input
                          className="h-8 w-12 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-1"
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
                        {supportsVisualFocus ? (
                          <label className="inline-flex h-8 items-center gap-2 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] px-2 text-xs text-[var(--sc-text-2)]">
                            <input
                              type="checkbox"
                              checked={highlightEnabled(stepPolish?.highlight)}
                              disabled={simulatorActive}
                              onChange={(event) =>
                                updateStepPolish(sceneIndex, commandIndex, {
                                  highlight: { ...highlight, enabled: event.target.checked },
                                })
                              }
                            />
                            Highlight
                          </label>
                        ) : null}
                        {supportsVisualFocus ? (
                          <input
                            className="h-8 min-w-[180px] rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface)] px-2 text-xs text-[var(--sc-text)] outline-none focus:border-[var(--sc-accent-400)]"
                            value={sfx.path}
                            disabled={simulatorActive}
                            placeholder="SFX path"
                            onChange={(event) =>
                              updateStepPolish(sceneIndex, commandIndex, {
                                sfx: event.target.value.trim()
                                  ? { ...sfx, path: event.target.value }
                                  : undefined,
                              })
                            }
                            aria-label={`${commandTitle(command)} sound effect path`}
                          />
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--sc-border-2)] bg-[var(--sc-chrome)] px-3 py-2 text-xs text-[var(--sc-text-3)]">
        <ArrowRight size={12} aria-hidden="true" />
        UI mode writes canonical DSL. Code-only custom lines are edited in Code mode.
      </div>
    </form>
  );
}

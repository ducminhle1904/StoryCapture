import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { NumberInput as AstryxNumberInput } from "@astryxdesign/core/NumberInput";
import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem as AstryxSegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
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
import { type ReactNode, useEffect, useState } from "react";
import type { Command, ScrollDir, ScrollUnit, Story } from "@/ipc/parse";
import {
  isPicked,
  type PickCandidate,
  type PickLocator,
  pickElementAuthor,
  pickerStampStepId,
  type TargetRecordDto,
} from "@/ipc/picker";
import {
  parseTextOverlayDuration,
  TEXT_OVERLAY_MAX_DURATION_MS,
  TEXT_OVERLAY_MIN_DURATION_MS,
  validateTextOverlayText,
} from "@/ipc/text-overlay";
import { notifications } from "@/lib/notifications";
import { MIN_RESIZABLE_ZOOM_DURATION_MS } from "../post-production/state/zoom-motion";
import {
  calloutText,
  DEFAULT_AUTO_ZOOM_DURATION_MS,
  highlightEnabled,
  type PolishActionFocus,
  type PolishAutoZoom,
  type PolishBackground,
  type PolishCallout,
  type PolishCursorMode,
  type PolishCursorSkin,
  type PolishHighlight,
  type PolishMotionMode,
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
  onSourceChange: (source: string, optimisticStory?: Story) => void;
  onSourceCommit: (source: string, optimisticStory?: Story) => Promise<void>;
  onFlushSource?: () => void;
  onPolishChange: (doc: StoryPolishDoc) => void;
  onJumpToOffset: (offset: number) => void;
  onValidityChange?: (valid: boolean) => void;
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
const motionModeOptions = [
  { value: "full", label: "Full" },
  { value: "reduced", label: "Reduced" },
];
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
const scrollDirectionOptions = [
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];
const scrollUnitOptions = [
  { value: "px", label: "px" },
  { value: "vh", label: "vh" },
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

function FieldLabel({ children }: { children: string }) {
  return (
    <span className="text-[10px] font-medium uppercase text-[var(--color-text-disabled)]">
      {children}
    </span>
  );
}

function PolishGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-disabled)]">
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

type TextOverlayCommand = Extract<Command, { verb: "text-overlay" }>;

function TextOverlayCommandFields({
  command,
  disabled,
  onPatch,
}: {
  command: TextOverlayCommand;
  disabled: boolean;
  onPatch: (patch: Partial<TextOverlayCommand>) => void;
}) {
  const [text, setText] = useState(command.text);
  const [duration, setDuration] = useState(String(command.duration_ms));
  const textError = validateTextOverlayText(text);
  const durationError = parseTextOverlayDuration(`${duration}ms`).error;
  const fieldId = command.step_id ?? `text-overlay-${command.span.start}`;

  useEffect(() => {
    setText(command.text);
  }, [command.text]);

  useEffect(() => {
    setDuration(String(command.duration_ms));
  }, [command.duration_ms]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_8rem] items-start gap-2">
      <LabeledControl label="Text">
        <AstryxTextInput
          label="Text overlay text"
          isLabelHidden
          width="100%"
          value={text}
          isDisabled={disabled}
          isRequired
          status={textError ? { type: "error" } : undefined}
          onChange={(value) => {
            const error = validateTextOverlayText(value);
            setText(value);
            if (!error) onPatch({ text: value });
          }}
        />
        {textError ? (
          <span
            id={`${fieldId}-text-error`}
            className="text-[10px]"
            style={{ color: "var(--color-error, #c33)" }}
          >
            {textError}
          </span>
        ) : null}
      </LabeledControl>
      <LabeledControl label="Duration">
        <div className="relative">
          <input
            className="h-8 w-full rounded-[var(--radius-inner)] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 pr-7 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
            type="number"
            min={TEXT_OVERLAY_MIN_DURATION_MS}
            max={TEXT_OVERLAY_MAX_DURATION_MS}
            step={1}
            value={duration}
            disabled={disabled}
            required
            aria-label="Text overlay duration"
            aria-invalid={Boolean(durationError)}
            aria-describedby={durationError ? `${fieldId}-duration-error` : undefined}
            onChange={(event) => {
              const value = event.target.value;
              const parsed = parseTextOverlayDuration(`${value}ms`);
              setDuration(value);
              if (parsed.durationMs != null) onPatch({ duration_ms: parsed.durationMs });
            }}
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--color-text-disabled)]">
            ms
          </span>
        </div>
        {durationError ? (
          <span
            id={`${fieldId}-duration-error`}
            className="text-[10px]"
            style={{ color: "var(--color-error, #c33)" }}
          >
            {durationError}
          </span>
        ) : null}
      </LabeledControl>
    </div>
  );
}

function polishChipClass(active: boolean): string {
  return [
    "inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-inner)] border px-2 text-[11px] font-medium transition-[background-color,border-color,transform] active:scale-[0.98]",
    active
      ? "border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]"
      : "border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
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
    case "text-overlay":
      return "Text overlay";
    case "wait-for":
      return "Wait for";
    case "wait-for-visible":
      return "Wait for visible";
    case "assert-visible":
      return "Assert visible";
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
    case "assert-visible":
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
    case "text-overlay":
      return `${command.text} / ${command.duration_ms}ms`;
    case "wait-for":
    case "wait-for-visible":
      return `${targetLabel(command.target)}${command.timeout_ms ? ` / ${command.timeout_ms}ms` : ""}`;
    case "screenshot":
      return command.name;
    case "scroll":
      return `${command.target ? `${targetLabel(command.target)} ` : ""}${command.direction} ${command.amount}${command.unit}`;
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
    case "assert-visible":
    case "wait-for":
    case "wait-for-visible":
      return command.target.kind === "role" ? command.target.value.name : command.target.value;
    case "wait":
      return String(command.duration_ms);
    case "text-overlay":
      return command.text;
    case "scroll":
      return String(command.amount);
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
  onValidityChange,
}: StoryBuilderProps) {
  const [pickingKey, setPickingKey] = useState<string | null>(null);
  const [expandedPolishKey, setExpandedPolishKey] = useState<string | null>(null);
  const [intentExpanded, setIntentExpanded] = useState(true);

  useEffect(() => () => onValidityChange?.(true), [onValidityChange]);

  if (!story) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-[var(--color-text-secondary)]">
        Switch to Code mode to fix parse errors before using UI mode.
      </div>
    );
  }

  const updateGlobal = (
    patch: Partial<{
      recipe: PolishRecipe;
      autoZoom: PolishAutoZoom;
      actionFocus: PolishActionFocus;
      motionMode: PolishMotionMode;
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
      case "text-overlay":
        patch = { text: value };
        break;
      case "scroll": {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount <= 0) return;
        patch = { amount };
        break;
      }
      case "click":
      case "hover":
      case "assert":
      case "assert-visible":
      case "wait-for":
      case "wait-for-visible":
        patch = updateCommandTarget(command, value) as Partial<Command>;
        break;
      case "drag":
      case "pause":
        return;
    }
    const nextStory = patchCommand(story, sceneIndex, commandIndex, patch);
    onSourceChange(formatEditableStory(nextStory), nextStory);
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
      onSourceChange(formatEditableStory(nextStory), nextStory);
    }
    onPolishChange(setStepPolish(polish, stepId, patch));
  };

  const pickTarget = async (sceneIndex: number, commandIndex: number, command: Command) => {
    if (simulatorActive || !commandSupportsPick(command)) return;
    if (!streamId) {
      notifications.warning("Enable Live Preview first — Pick needs an author session");
      return;
    }
    const pickKey = `${sceneIndex}-${commandIndex}`;
    setPickingKey(pickKey);
    try {
      const { story: storyWithId } = cloneStoryWithStepId(story, sceneIndex, commandIndex);
      const commandWithId = storyWithId.scenes[sceneIndex]?.commands[commandIndex] ?? command;
      if (!command.step_id) {
        await onSourceCommit(formatEditableStory(storyWithId), storyWithId);
      }
      const result = await pickElementAuthor({
        streamId,
        storySrc: storySource,
        cursorLine: command.span.line,
        timeoutMs: 60_000,
      });
      if (!isPicked(result)) {
        if (result.reason !== "user-cancel") notifications.info(`Picking ended: ${result.reason}`);
        return;
      }

      const patched = patchCommand(
        storyWithId,
        sceneIndex,
        commandIndex,
        updateCommandTargetFromPick(commandWithId, result.locator),
      );
      await onSourceCommit(formatEditableStory(patched), patched);

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
      notifications.success("Updated target");
    } catch (error) {
      notifications.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPickingKey(null);
    }
  };

  return (
    <form
      aria-label="Story builder"
      className="flex h-full flex-col overflow-hidden bg-[var(--color-background-surface)]"
      onSubmit={(event) => event.preventDefault()}
      onChange={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        const hasOtherInvalidField = Array.from(
          event.currentTarget.querySelectorAll('[aria-invalid="true"]'),
        ).some((field) => field !== target);
        onValidityChange?.(target.validity.valid && !hasOtherInvalidField);
      }}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          onFlushSource?.();
        }
      }}
    >
      <div className="shrink-0 border-b border-[var(--color-border-emphasized)] bg-[var(--story-native-chrome)]">
        <div className="flex h-10 items-center gap-2 px-3">
          <Sparkles size={14} aria-hidden="true" className="text-[var(--color-accent)]" />
          <AstryxButton
            variant="ghost"
            size="sm"
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] font-semibold uppercase text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
            aria-expanded={intentExpanded}
            onClick={() => setIntentExpanded((value) => !value)}
            label="Post-production intent"
            endContent={
              <ChevronDown
                size={13}
                aria-hidden="true"
                className={`transition-transform ${intentExpanded ? "rotate-180" : ""}`}
              />
            }
          >
            <span className="truncate">Post-production intent</span>
          </AstryxButton>
          <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 py-0.5 font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
            {polish.global.recipe}
          </span>
        </div>
        {intentExpanded ? (
          <div className="grid grid-cols-1 gap-3 px-3 pb-3 lg:grid-cols-2">
            <PolishGroup title="Style">
              <AstryxSegmentedControl
                size="sm"
                value={polish.global.recipe}
                label="Polish recipe"
                isDisabled={simulatorActive}
                onChange={(value) => updateGlobal({ recipe: value as PolishRecipe })}
              >
                {recipeOptions.map((option) => (
                  <AstryxSegmentedControlItem
                    key={option.value}
                    value={option.value}
                    label={typeof option.label === "string" ? option.label : option.value}
                    icon={typeof option.label === "string" ? undefined : option.label}
                  />
                ))}
              </AstryxSegmentedControl>
            </PolishGroup>

            <PolishGroup title="Motion">
              <LabeledControl label="Motion mode" className="min-w-[140px] flex-1">
                <AstryxSegmentedControl
                  size="sm"
                  value={polish.global.motionMode ?? "full"}
                  label="Motion mode"
                  isDisabled={simulatorActive}
                  onChange={(value) => updateGlobal({ motionMode: value as PolishMotionMode })}
                >
                  {motionModeOptions.map((option) => (
                    <AstryxSegmentedControlItem
                      key={option.value}
                      value={option.value}
                      label={typeof option.label === "string" ? option.label : option.value}
                      icon={typeof option.label === "string" ? undefined : option.label}
                    />
                  ))}
                </AstryxSegmentedControl>
              </LabeledControl>
              <LabeledControl label="Auto zoom" className="min-w-[140px] flex-1">
                <AstryxSelector
                  value={polish.global.autoZoom}
                  isDisabled={simulatorActive}
                  options={autoZoomOptions}
                  onChange={(value) => updateGlobal({ autoZoom: value as PolishAutoZoom })}
                  label="Auto zoom"
                  isLabelHidden
                />
              </LabeledControl>
              <LabeledControl label="Action focus" className="min-w-[140px] flex-1">
                <AstryxSelector
                  value={polish.global.actionFocus}
                  isDisabled={simulatorActive}
                  options={actionFocusOptions}
                  onChange={(value) => updateGlobal({ actionFocus: value as PolishActionFocus })}
                  label="Action focus"
                  isLabelHidden
                />
              </LabeledControl>
              <LabeledControl label="Duration" className="w-24">
                <input
                  className="h-8 w-full rounded-[var(--radius-inner)] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                  type="number"
                  min={MIN_RESIZABLE_ZOOM_DURATION_MS}
                  step={100}
                  value={polish.global.autoZoomDurationMs}
                  disabled={simulatorActive}
                  aria-label="Auto zoom duration"
                  onChange={(event) => {
                    updateGlobal({
                      autoZoomDurationMs: Math.max(
                        MIN_RESIZABLE_ZOOM_DURATION_MS,
                        Number(event.target.value) || DEFAULT_AUTO_ZOOM_DURATION_MS,
                      ),
                    });
                  }}
                />
              </LabeledControl>
            </PolishGroup>

            <PolishGroup title="Cursor">
              <LabeledControl label="Mode" className="min-w-[120px] flex-1">
                <AstryxSelector
                  value={polish.global.cursor}
                  isDisabled={simulatorActive}
                  options={cursorModeOptions}
                  onChange={(value) => updateGlobal({ cursor: value as PolishCursorMode })}
                  label="Cursor mode"
                  isLabelHidden
                />
              </LabeledControl>
              <LabeledControl label="Skin" className="min-w-[120px] flex-1">
                <AstryxSelector
                  value={polish.global.cursorSkin}
                  isDisabled={simulatorActive || polish.global.cursor === "hidden"}
                  options={cursorSkinOptions}
                  onChange={(value) => updateGlobal({ cursorSkin: value as PolishCursorSkin })}
                  label="Cursor skin"
                  isLabelHidden
                />
              </LabeledControl>
              <LabeledControl label="Size" className="w-20">
                <AstryxNumberInput
                  label="Cursor size"
                  isLabelHidden
                  size="sm"
                  min={0.5}
                  max={2.5}
                  step={0.1}
                  value={polish.global.cursorSizeScale}
                  isDisabled={simulatorActive || polish.global.cursor === "hidden"}
                  width="100%"
                  onChange={(value) =>
                    updateGlobal({
                      cursorSizeScale: Math.max(0.5, value || 1),
                    })
                  }
                />
              </LabeledControl>
            </PolishGroup>

            <PolishGroup title="Canvas & Audio">
              <LabeledControl label="Background" className="min-w-[150px] flex-1">
                <AstryxSelector
                  value={backgroundToValue(polish.global.background)}
                  isDisabled={simulatorActive}
                  options={[...backgroundOptions]}
                  onChange={(value) => updateGlobal({ background: backgroundFromValue(value) })}
                  label="Background"
                  isLabelHidden
                />
              </LabeledControl>
              <LabeledControl label="BGM asset" className="min-w-[180px] flex-1">
                <AstryxTextInput
                  label="Background music path"
                  isLabelHidden
                  value={polish.global.bgm?.path ?? ""}
                  isDisabled={simulatorActive}
                  placeholder="Choose or paste audio path"
                  width="100%"
                  onChange={(value) =>
                    updateGlobal({
                      bgm: value.trim()
                        ? {
                            ...soundCueObject(polish.global.bgm),
                            path: value,
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
              className="mb-5 border-b border-[var(--color-border-emphasized)] pb-5 last:border-b-0"
            >
              <div className="mb-3 flex items-center gap-2">
                <AstryxTextInput
                  label={`Scene ${sceneIndex + 1} name`}
                  isLabelHidden
                  className="min-w-0 flex-1 font-semibold"
                  value={scene.name}
                  isDisabled={simulatorActive}
                  width="100%"
                  onChange={(value) => {
                    const nextStory = patchSceneName(story, sceneIndex, value);
                    onSourceChange(formatEditableStory(nextStory), nextStory);
                  }}
                />
                <LabeledControl label="Transition" className="w-40">
                  <AstryxSelector
                    value={scenePolish.transitionOut ?? "none"}
                    isDisabled={simulatorActive}
                    options={transitionOptions}
                    onChange={(value) =>
                      onPolishChange(
                        setScenePolish(polish, scene.name, {
                          transitionOut: value as PolishTransition,
                        }),
                      )
                    }
                    label={`Transition for ${scene.name}`}
                    isLabelHidden
                  />
                </LabeledControl>
                <LabeledControl label="Duration" className="w-24">
                  <AstryxNumberInput
                    label={`Transition duration for ${scene.name}`}
                    isLabelHidden
                    size="sm"
                    min={100}
                    step={100}
                    units="ms"
                    value={scenePolish.transitionDurationMs ?? 500}
                    isDisabled={simulatorActive || !scenePolish.transitionOut}
                    width="100%"
                    onChange={(value) =>
                      onPolishChange(
                        setScenePolish(polish, scene.name, {
                          transitionDurationMs: Math.max(100, value || 500),
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
                      className="rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-card)] p-3"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <AstryxBadge variant="neutral" label={commandTitle(command)} />
                        <AstryxButton
                          variant="ghost"
                          size="sm"
                          className="min-w-0 flex-1 truncate text-left text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                          onClick={() => onJumpToOffset(command.span.start)}
                          label={`Jump to ${commandSummary(command)}`}
                        >
                          {commandSummary(command)}
                        </AstryxButton>
                        <Code2
                          size={12}
                          aria-hidden="true"
                          className="text-[var(--color-text-disabled)]"
                        />
                      </div>

                      {command.verb === "text-overlay" ? (
                        <TextOverlayCommandFields
                          command={command}
                          disabled={simulatorActive}
                          onPatch={(patch) => {
                            const nextStory = patchCommand(story, sceneIndex, commandIndex, patch);
                            onSourceChange(formatEditableStory(nextStory), nextStory);
                          }}
                        />
                      ) : (
                        <div
                          className={
                            supportsPick
                              ? "grid grid-cols-[1fr_auto] items-center gap-2"
                              : "grid grid-cols-1"
                          }
                        >
                          <AstryxTextInput
                            label={`${commandTitle(command)} value`}
                            isLabelHidden
                            value={primaryEditableValue(command)}
                            isDisabled={
                              simulatorActive || command.verb === "drag" || command.verb === "pause"
                            }
                            width="100%"
                            onChange={(value) =>
                              updateSourceCommand(sceneIndex, commandIndex, command, value)
                            }
                            aria-label={`${commandTitle(command)} value`}
                          />
                          {supportsPick ? (
                            <AstryxButton
                              size="sm"
                              variant="ghost"
                              isDisabled={simulatorActive || pickingKey === pickKey}
                              icon={<MousePointer2 size={12} aria-hidden="true" />}
                              tooltip="Pick target from preview"
                              className="h-9 self-center"
                              onClick={() => pickTarget(sceneIndex, commandIndex, command)}
                              label="Pick target from preview"
                            >
                              {pickingKey === pickKey ? "Picking" : "Pick"}
                            </AstryxButton>
                          ) : null}
                        </div>
                      )}

                      {command.verb === "scroll" ? (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <AstryxSelector
                            value={command.direction}
                            isDisabled={simulatorActive}
                            options={scrollDirectionOptions}
                            label="Scroll direction"
                            isLabelHidden
                            onChange={(value) => {
                              const nextStory = patchCommand(story, sceneIndex, commandIndex, {
                                direction: value as ScrollDir,
                              } as Partial<Command>);
                              onSourceChange(formatEditableStory(nextStory), nextStory);
                            }}
                          />
                          <AstryxSelector
                            value={command.unit}
                            isDisabled={simulatorActive}
                            options={scrollUnitOptions}
                            label="Scroll unit"
                            isLabelHidden
                            onChange={(value) => {
                              const nextStory = patchCommand(story, sceneIndex, commandIndex, {
                                unit: value as ScrollUnit,
                              } as Partial<Command>);
                              onSourceChange(formatEditableStory(nextStory), nextStory);
                            }}
                          />
                        </div>
                      ) : null}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {supportsVisualFocus ? (
                          <AstryxButton
                            variant="secondary"
                            size="sm"
                            className={polishChipClass(zoomEnabled)}
                            label={`Zoom ${zoomEnabled ? stepPolish?.zoom : "off"}`}
                            icon={<Focus size={12} aria-hidden="true" />}
                            onClick={() =>
                              setExpandedPolishKey((current) =>
                                current === stepKey ? null : stepKey,
                              )
                            }
                          >
                            Zoom {zoomEnabled ? stepPolish?.zoom : "off"}
                          </AstryxButton>
                        ) : null}
                        <AstryxButton
                          variant="secondary"
                          size="sm"
                          className={polishChipClass(Boolean(calloutValue))}
                          label={calloutValue ? "Callout" : "No callout"}
                          icon={<Megaphone size={12} aria-hidden="true" />}
                          onClick={() =>
                            setExpandedPolishKey((current) =>
                              current === stepKey ? null : stepKey,
                            )
                          }
                        >
                          {calloutValue ? "Callout" : "No callout"}
                        </AstryxButton>
                        {supportsVisualFocus ? (
                          <AstryxButton
                            variant="secondary"
                            size="sm"
                            className={polishChipClass(highlightActive)}
                            label={`Highlight ${highlightActive ? "on" : "off"}`}
                            icon={<Palette size={12} aria-hidden="true" />}
                            onClick={() =>
                              updateStepPolish(sceneIndex, commandIndex, {
                                highlight: { ...highlight, enabled: !highlightActive },
                              })
                            }
                          >
                            Highlight {highlightActive ? "on" : "off"}
                          </AstryxButton>
                        ) : null}
                        {supportsVisualFocus ? (
                          <AstryxButton
                            variant="secondary"
                            size="sm"
                            className={polishChipClass(sfxActive)}
                            label={sfxActive ? "SFX" : "No SFX"}
                            icon={<Volume2 size={12} aria-hidden="true" />}
                            onClick={() =>
                              setExpandedPolishKey((current) =>
                                current === stepKey ? null : stepKey,
                              )
                            }
                          >
                            {sfxActive ? "SFX" : "No SFX"}
                          </AstryxButton>
                        ) : null}
                        <AstryxButton
                          variant="ghost"
                          size="sm"
                          className="ml-auto inline-flex h-7 items-center gap-1 rounded-[var(--radius-inner)] px-2 text-[11px] text-[var(--color-text-secondary)] transition hover:bg-[var(--color-background-surface)] hover:text-[var(--color-text-primary)] active:scale-[0.98]"
                          aria-expanded={polishOpen}
                          label="Polish"
                          endContent={
                            <ChevronDown
                              size={12}
                              aria-hidden="true"
                              className={`transition-transform ${polishOpen ? "rotate-180" : ""}`}
                            />
                          }
                          onClick={() =>
                            setExpandedPolishKey((current) =>
                              current === stepKey ? null : stepKey,
                            )
                          }
                        >
                          Polish
                        </AstryxButton>
                      </div>

                      {polishOpen ? (
                        <div className="mt-3 border-t border-[var(--color-border-emphasized)] pt-3">
                          <div
                            className={
                              supportsVisualFocus
                                ? "grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(120px,0.9fr)_minmax(300px,1.35fr)_minmax(220px,1fr)]"
                                : "grid grid-cols-1"
                            }
                          >
                            {supportsVisualFocus ? (
                              <fieldset className="border-0 p-0">
                                <legend className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-disabled)]">
                                  <Focus size={11} aria-hidden="true" /> Focus
                                </legend>
                                <div className="flex flex-wrap items-end gap-2">
                                  <LabeledControl label="Zoom" className="w-32">
                                    <AstryxSelector
                                      value={stepPolish?.zoom ?? "off"}
                                      isDisabled={simulatorActive}
                                      options={zoomOptions}
                                      onChange={(value) =>
                                        updateStepPolish(sceneIndex, commandIndex, {
                                          zoom: value as PolishZoom,
                                        })
                                      }
                                      label={`${commandTitle(command)} zoom`}
                                      isLabelHidden
                                    />
                                  </LabeledControl>
                                  {zoomEnabled ? (
                                    <LabeledControl label="Target" className="w-36">
                                      <AstryxSelector
                                        value={zoomTarget.kind}
                                        isDisabled={simulatorActive}
                                        options={zoomTargetOptions}
                                        label={`${commandTitle(command)} zoom target`}
                                        isLabelHidden
                                        onChange={(value) => {
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
                                      <AstryxTextInput
                                        label={`${commandTitle(command)} zoom selector`}
                                        isLabelHidden
                                        value={zoomTarget.selector}
                                        isDisabled={simulatorActive}
                                        placeholder="CSS selector"
                                        width="100%"
                                        onChange={(value) =>
                                          updateStepPolish(sceneIndex, commandIndex, {
                                            zoomTarget: {
                                              kind: "element",
                                              selector: value,
                                            },
                                          })
                                        }
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
                              <legend className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-disabled)]">
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
                                  <AstryxTextInput
                                    label={`${commandTitle(command)} callout`}
                                    isLabelHidden
                                    value={calloutValue}
                                    isDisabled={simulatorActive}
                                    placeholder="Add callout text"
                                    width="100%"
                                    onChange={(value) =>
                                      updateStepPolish(sceneIndex, commandIndex, {
                                        callout: { ...callout, text: value },
                                      })
                                    }
                                  />
                                </LabeledControl>
                                <LabeledControl label="Size">
                                  <AstryxNumberInput
                                    label={`${commandTitle(command)} callout size`}
                                    isLabelHidden
                                    size="sm"
                                    min={12}
                                    max={72}
                                    step={1}
                                    units="pt"
                                    value={callout.sizePt}
                                    isDisabled={simulatorActive}
                                    width="100%"
                                    onChange={(value) =>
                                      updateStepPolish(sceneIndex, commandIndex, {
                                        callout: {
                                          ...callout,
                                          sizePt: Math.max(12, value || 24),
                                        },
                                      })
                                    }
                                  />
                                </LabeledControl>
                                <LabeledControl label="Color">
                                  <input
                                    className="h-8 rounded-[var(--radius-inner)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-1"
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
                                <legend className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-disabled)]">
                                  <Music2 size={11} aria-hidden="true" /> Effects
                                </legend>
                                <div className="grid grid-cols-1 items-end gap-3">
                                  <LabeledControl label="Highlight" className="min-w-0">
                                    <AstryxSwitch
                                      label="Highlight enabled"
                                      isLabelHidden
                                      value={highlightActive}
                                      isDisabled={simulatorActive}
                                      onChange={(enabled) =>
                                        updateStepPolish(sceneIndex, commandIndex, {
                                          highlight: {
                                            ...highlight,
                                            enabled,
                                          },
                                        })
                                      }
                                    />
                                  </LabeledControl>
                                  <LabeledControl label="SFX asset" className="min-w-0">
                                    <AstryxTextInput
                                      label={`${commandTitle(command)} sound effect path`}
                                      isLabelHidden
                                      value={sfx.path}
                                      isDisabled={simulatorActive}
                                      placeholder="Choose or paste audio path"
                                      width="100%"
                                      onChange={(value) =>
                                        updateStepPolish(sceneIndex, commandIndex, {
                                          sfx: value.trim() ? { ...sfx, path: value } : undefined,
                                        })
                                      }
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

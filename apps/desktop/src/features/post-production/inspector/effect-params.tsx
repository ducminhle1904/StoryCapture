/**
 * EffectParams — form for the selected clip's parameters. Common metadata
 * is always shown; typed forms are rendered for clip variants that expose
 * first-class controls. Edits dispatch structured `set-effect-param`
 * actions through the undo slice.
 */

import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SelectField } from "@/components/ui/select-field";
import { createClipId } from "../state/clip-id";
import { CURSOR_MOTION_LABELS } from "../state/cursor-motion";
import { buildCursorPresetReflow } from "../state/cursor-preset-reflow";
import { useEditorStore } from "../state/store";
import {
  avoidAnchorPosition,
  currentStepForPlayhead,
  resolveTextAnchorPosition,
  safeAreaPosition,
  targetAnchorHasGeometry,
  targetAnchorPosition,
} from "../state/text-anchor";
import { styleDefaults, TEXT_STYLE_IDS, TEXT_STYLE_PRESETS } from "../state/text-style";
import type {
  AnnotationClip,
  Clip,
  CursorClip,
  CursorMotionPreset,
  CursorSkin,
  SoundClip,
  SoundKind,
  TextAlign,
  TextAnchor,
  TextAnimationKind,
  TextStyleId,
  TimelineSlice,
  TrackId,
  Vec2,
  VideoClip,
  XfadeKind,
  ZoomClip,
  ZoomPreset,
  ZoomTarget,
} from "../state/timeline-slice";
import {
  CURSOR_MOTION_PRESETS,
  normalizeCursorMotionPreset,
  TRACK_IDS,
  XFADE_KINDS,
} from "../state/timeline-slice";

const FIELD_CLASS =
  "min-h-10 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]";

const RANGE_CLASS = "w-full accent-[var(--color-accent,#ff5b76)]";
const SECTION_CLASS =
  "rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3";
const FIELD_ROW_CLASS = "flex flex-col gap-1.5";
const SECONDARY_BUTTON_CLASS =
  "rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-2 text-xs font-medium text-[var(--color-fg)] transition-[background-color,transform,border-color] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-100)] active:scale-[0.98] disabled:opacity-45";
const TINY_BUTTON_CLASS =
  "rounded-[6px] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[10px] font-medium text-[var(--color-fg-muted)] transition-[background-color,color,transform,border-color] hover:border-[var(--color-border)] hover:text-[var(--color-fg)] active:scale-[0.98]";

const FX_LAYER_IDS: TrackId[] = ["annotations", "zoom", "cursor", "sound", "video"];

const PRESET_OPTIONS: ZoomPreset[] = ["DYNAMIC", "CALM", "SUBTLE"];
const TARGET_KIND_OPTIONS: ZoomTarget["kind"][] = ["cursor", "element", "fixed-region"];
const CURSOR_SKIN_OPTIONS: CursorSkin[] = [
  "mac-default",
  "win-default",
  "dark",
  "light",
  "big-arrow",
];
const SOUND_KIND_OPTIONS: SoundKind[] = ["bgm", "sfx", "voiceover"];
const TRANSITION_KIND_OPTIONS = XFADE_KINDS;
const TEXT_ALIGN_OPTIONS: TextAlign[] = ["left", "center", "right"];
const TEXT_ANIM_IN_OPTIONS: TextAnimationKind[] = ["none", "fade", "slide-up", "scale-in"];
const TEXT_ANIM_OUT_OPTIONS: Array<"none" | "fade"> = ["none", "fade"];
const TEXT_ANCHOR_KIND_OPTIONS: TextAnchor["kind"][] = ["screen", "safe-area", "cursor", "target"];
const TEXT_TARGET_PLACEMENT_OPTIONS: Array<Extract<TextAnchor, { kind: "target" }>["placement"]> = [
  "top",
  "right",
  "bottom",
  "left",
];
const TEXT_SAFE_AREA_OPTIONS: Array<Extract<TextAnchor, { kind: "safe-area" }>["placement"]> = [
  "top",
  "bottom",
  "center",
];

const targetKindSelectOptions = TARGET_KIND_OPTIONS.map((kind) => ({
  value: kind,
  label: labelForTargetKind(kind),
}));
const presetSelectOptions = PRESET_OPTIONS.map((preset) => ({ value: preset, label: preset }));
const cursorSkinSelectOptions = CURSOR_SKIN_OPTIONS.map((skin) => ({ value: skin, label: skin }));
const cursorMotionSelectOptions = CURSOR_MOTION_PRESETS.map((preset) => ({
  value: preset,
  label: CURSOR_MOTION_LABELS[preset],
}));
const soundKindSelectOptions = SOUND_KIND_OPTIONS.map((kind) => ({ value: kind, label: kind }));
const transitionKindSelectOptions = TRANSITION_KIND_OPTIONS.map((kind) => ({
  value: kind,
  label: kind,
}));
const textStyleSelectOptions = TEXT_STYLE_IDS.map((id) => ({
  value: id,
  label: TEXT_STYLE_PRESETS[id].label,
}));
const textAlignSelectOptions = TEXT_ALIGN_OPTIONS.map((align) => ({ value: align, label: align }));
const textAnimInSelectOptions = TEXT_ANIM_IN_OPTIONS.map((anim) => ({ value: anim, label: anim }));
const textAnimOutSelectOptions = TEXT_ANIM_OUT_OPTIONS.map((anim) => ({
  value: anim,
  label: anim,
}));
const textAnchorKindSelectOptions = TEXT_ANCHOR_KIND_OPTIONS.map((kind) => ({
  value: kind,
  label: kind,
}));
const textTargetPlacementSelectOptions = TEXT_TARGET_PLACEMENT_OPTIONS.map((placement) => ({
  value: placement,
  label: placement,
}));
const textSafeAreaSelectOptions = TEXT_SAFE_AREA_OPTIONS.map((placement) => ({
  value: placement,
  label: placement,
}));

function labelForTargetKind(kind: ZoomTarget["kind"]): string {
  switch (kind) {
    case "cursor":
      return "Cursor";
    case "element":
      return "Element";
    case "fixed-region":
      return "Region";
  }
}

function defaultTarget(kind: ZoomTarget["kind"]): ZoomTarget {
  switch (kind) {
    case "cursor":
      return { kind: "cursor" };
    case "element":
      return { kind: "element", selector: "" };
    case "fixed-region":
      return {
        kind: "fixed-region",
        top_left: { x: 0.25, y: 0.25 },
        size: { x: 0.5, y: 0.5 },
      };
  }
}

function parseFiniteNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Project a clip into the JSON view shown in the inspector — the
 * variant-specific parameter fields, with the framing fields (id,
 * trackId, startMs, durationMs, label) stripped because the form
 * surfaces them separately.
 */
function clipParams(clip: Clip): Record<string, unknown> {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    id,
    trackId,
    startMs,
    durationMs,
    label,
    ...rest
  } = clip;
  return rest;
}

interface SelectedClipHit {
  trackId: TrackId;
  clip: Clip;
  index: number;
}

interface CursorClipHit {
  clip: CursorClip;
  index: number;
}

function findSelectedClip(
  tracks: TimelineSlice["tracks"],
  selectedClipId: string | null,
): SelectedClipHit | null {
  if (!selectedClipId) return null;
  for (const track of TRACK_IDS) {
    const index = tracks[track].findIndex((c) => c.id === selectedClipId);
    const clip = index >= 0 ? tracks[track][index] : null;
    if (clip) return { trackId: track, clip, index };
  }
  return null;
}

function findActiveCursorClip(
  tracks: TimelineSlice["tracks"],
  referenceMs: number,
): CursorClipHit | null {
  let active: CursorClipHit | null = null;
  tracks.cursor.forEach((clip, index) => {
    const endMs = clip.startMs + clip.durationMs;
    if (referenceMs < clip.startMs || referenceMs >= endMs) return;
    if (!active || clip.startMs >= active.clip.startMs) active = { clip, index };
  });
  return active;
}

interface FieldLabelProps {
  children: ReactNode;
}

function FieldLabel({ children }: FieldLabelProps) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

function ValuePill({ children }: FieldLabelProps) {
  return (
    <span className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.56)]">
      {children}
    </span>
  );
}

function SectionTitle({ children }: FieldLabelProps) {
  return <legend className="text-xs font-semibold text-[var(--color-fg)]">{children}</legend>;
}

function SectionCopy({ children }: FieldLabelProps) {
  return <p className="mt-1 text-[11px] leading-4 text-[var(--color-fg-muted)]">{children}</p>;
}

function clipTypeLabel(trackId: TrackId): string {
  switch (trackId) {
    case "video":
      return "Video";
    case "cursor":
      return "Cursor";
    case "zoom":
      return "Zoom";
    case "sound":
      return "Sound";
    case "annotations":
      return "Text";
  }
}

function layerDescription(trackId: TrackId): string {
  switch (trackId) {
    case "video":
      return "Base clips and transitions.";
    case "cursor":
      return "Pointer skin and motion.";
    case "zoom":
      return "Camera moves and focus.";
    case "sound":
      return "BGM, SFX, and voiceover.";
    case "annotations":
      return "Callouts and captions.";
  }
}

function clipTypeAccent(trackId: TrackId): string {
  switch (trackId) {
    case "video":
      return "#0284c7";
    case "cursor":
      return "#059669";
    case "zoom":
      return "#b45309";
    case "sound":
      return "#15803d";
    case "annotations":
      return "#c2410c";
  }
}

function clipListTitle(clip: Clip): string {
  switch (clip.trackId) {
    case "video":
      return clip.label ?? basename(clip.sourcePath);
    case "cursor":
      return clip.label ?? "Cursor Path";
    case "zoom":
      return clip.label ?? "Script Zoom";
    case "sound":
      return clip.label ?? basename(clip.path);
    case "annotations":
      return clip.text || clip.label || "Text";
  }
}

function clipListMeta(clip: Clip): string {
  switch (clip.trackId) {
    case "video":
      return clip.outgoingTransition?.kind.replace(/-/g, " ") ?? "source";
    case "cursor":
      return CURSOR_MOTION_LABELS[normalizeCursorMotionPreset(clip.motionPreset)];
    case "zoom":
      return `${clip.scale.toFixed(2)}x · ${clip.preset ?? "DYNAMIC"}`;
    case "sound":
      return clip.kind.toUpperCase();
    case "annotations":
      return TEXT_STYLE_PRESETS[clip.styleId ?? "callout"].label;
  }
}

function clipNodePath(trackId: TrackId, index: number): string {
  return `tracks.${trackId}[${index}]`;
}

interface ZoomParamsProps {
  clip: ZoomClip;
  nodePath: string;
  onSetParam: (nodePath: string, field: string, prev: unknown, next: unknown) => void;
}

function ZoomParams({ clip, nodePath, onSetParam }: ZoomParamsProps) {
  const centerPath = `${nodePath}.center`;
  const targetPath = `${nodePath}.target`;

  const onVec2Change = (path: string, vec: Vec2, field: keyof Vec2, value: string) => {
    const next = parseFiniteNumber(value, vec[field]);
    if (next !== vec[field]) onSetParam(path, field, vec[field], next);
  };

  const targetControls = (() => {
    switch (clip.target.kind) {
      case "element": {
        const target = clip.target;
        return (
          <label className={FIELD_ROW_CLASS}>
            <FieldLabel>Selector</FieldLabel>
            <input
              type="text"
              aria-label="Zoom element selector"
              value={target.selector}
              onChange={(e) => onSetParam(targetPath, "selector", target.selector, e.target.value)}
              className={FIELD_CLASS}
            />
          </label>
        );
      }
      case "fixed-region": {
        const target = clip.target;
        return (
          <div className="grid grid-cols-2 gap-2">
            <label className={FIELD_ROW_CLASS}>
              <FieldLabel>Region X</FieldLabel>
              <input
                type="number"
                aria-label="Zoom region x"
                value={target.top_left.x}
                step="0.01"
                min="0"
                max="1"
                onChange={(e) =>
                  onVec2Change(`${targetPath}.top_left`, target.top_left, "x", e.target.value)
                }
                className={FIELD_CLASS}
              />
            </label>
            <label className={FIELD_ROW_CLASS}>
              <FieldLabel>Region Y</FieldLabel>
              <input
                type="number"
                aria-label="Zoom region y"
                value={target.top_left.y}
                step="0.01"
                min="0"
                max="1"
                onChange={(e) =>
                  onVec2Change(`${targetPath}.top_left`, target.top_left, "y", e.target.value)
                }
                className={FIELD_CLASS}
              />
            </label>
            <label className={FIELD_ROW_CLASS}>
              <FieldLabel>Width</FieldLabel>
              <input
                type="number"
                aria-label="Zoom region width"
                value={target.size.x}
                step="0.01"
                min="0"
                max="1"
                onChange={(e) =>
                  onVec2Change(`${targetPath}.size`, target.size, "x", e.target.value)
                }
                className={FIELD_CLASS}
              />
            </label>
            <label className={FIELD_ROW_CLASS}>
              <FieldLabel>Height</FieldLabel>
              <input
                type="number"
                aria-label="Zoom region height"
                value={target.size.y}
                step="0.01"
                min="0"
                max="1"
                onChange={(e) =>
                  onVec2Change(`${targetPath}.size`, target.size, "y", e.target.value)
                }
                className={FIELD_CLASS}
              />
            </label>
          </div>
        );
      }
      case "cursor":
        return null;
    }
  })();

  return (
    <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
      <div>
        <SectionTitle>Zoom motion</SectionTitle>
        <SectionCopy>Choose what the camera follows, then tune the intensity.</SectionCopy>
      </div>
      <div className={FIELD_ROW_CLASS}>
        <FieldLabel>Target</FieldLabel>
        <SelectField
          aria-label="Zoom target"
          value={clip.target.kind}
          onValueChange={(value) => {
            const next = defaultTarget(value as ZoomTarget["kind"]);
            onSetParam(nodePath, "target", clip.target, next);
          }}
          options={targetKindSelectOptions}
        />
      </div>
      {targetControls}
      <label className={FIELD_ROW_CLASS}>
        <span className="flex items-center justify-between gap-2">
          <FieldLabel>Scale</FieldLabel>
          <ValuePill>{clip.scale.toFixed(2)}x</ValuePill>
        </span>
        <input
          type="range"
          aria-label="Zoom scale"
          value={clip.scale}
          min="1"
          max="3"
          step="0.05"
          onChange={(e) => {
            const next = parseFiniteNumber(e.target.value, clip.scale);
            if (next !== clip.scale) onSetParam(nodePath, "scale", clip.scale, next);
          }}
          className={RANGE_CLASS}
        />
      </label>
      <div className="grid grid-cols-2 gap-2 rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2">
        <label className={FIELD_ROW_CLASS}>
          <FieldLabel>Center X</FieldLabel>
          <input
            type="number"
            aria-label="Zoom center x"
            value={clip.center.x}
            step="0.01"
            min="0"
            max="1"
            onChange={(e) => onVec2Change(centerPath, clip.center, "x", e.target.value)}
            className={FIELD_CLASS}
          />
        </label>
        <label className={FIELD_ROW_CLASS}>
          <FieldLabel>Center Y</FieldLabel>
          <input
            type="number"
            aria-label="Zoom center y"
            value={clip.center.y}
            step="0.01"
            min="0"
            max="1"
            onChange={(e) => onVec2Change(centerPath, clip.center, "y", e.target.value)}
            className={FIELD_CLASS}
          />
        </label>
      </div>
      <div className={FIELD_ROW_CLASS}>
        <FieldLabel>Preset</FieldLabel>
        <SelectField
          aria-label="Zoom preset"
          value={clip.preset ?? "DYNAMIC"}
          onValueChange={(value) =>
            onSetParam(nodePath, "preset", clip.preset, value as ZoomPreset)
          }
          options={presetSelectOptions}
        />
      </div>
    </fieldset>
  );
}

interface AnnotationParamsProps {
  clip: AnnotationClip;
  nodePath: string;
  onSetParam: (nodePath: string, field: string, prev: unknown, next: unknown) => void;
}

function AnnotationParams({ clip, nodePath, onSetParam }: AnnotationParamsProps) {
  const posPath = `${nodePath}.pos`;
  const playheadMs = useEditorStore((s) => s.playheadMs);
  const cursorClips = useEditorStore((s) => s.tracks.cursor);
  const actions = useEditorStore((s) => s._undoExtras?.actions ?? null);
  const stepTiming = useEditorStore((s) => s._undoExtras?.stepTiming ?? null);
  const captureRect = useEditorStore((s) => s._undoExtras?.captureRect ?? null);
  const color = clip.color ?? "#ffffff";
  const preset = TEXT_STYLE_PRESETS[clip.styleId ?? "callout"];
  const boxStyle = clip.boxStyle ?? preset.boxStyle;
  const animation = clip.animation ?? preset.animation;
  const anchor = clip.anchor ?? { kind: "screen", pos: clip.pos };
  const currentStep = currentStepForPlayhead(stepTiming, playheadMs);
  const targetWarning =
    anchor.kind === "target" && !targetAnchorHasGeometry(anchor, actions, stepTiming, captureRect);

  const onPosChange = (field: keyof Vec2, value: string) => {
    const next = parseFiniteNumber(value, clip.pos[field]);
    if (next !== clip.pos[field]) onSetParam(posPath, field, clip.pos[field], next);
  };

  const setScreenPosition = (next: Vec2) => {
    onSetParam(nodePath, "pos", clip.pos, next);
    onSetParam(nodePath, "anchor", clip.anchor, { kind: "screen", pos: next });
  };

  const fitToCurrentStep = () => {
    if (!currentStep) return;
    onSetParam(nodePath, "startMs", clip.startMs, currentStep.startMs);
    onSetParam(nodePath, "durationMs", clip.durationMs, Math.max(100, currentStep.durationMs));
  };

  const attachToCurrentTarget = () => {
    if (!currentStep?.stepId) return;
    const nextAnchor: TextAnchor = { kind: "target", stepId: currentStep.stepId, placement: "top" };
    const nextPos = targetAnchorPosition(nextAnchor, actions, stepTiming, captureRect) ?? clip.pos;
    onSetParam(nodePath, "anchor", clip.anchor, nextAnchor);
    onSetParam(nodePath, "pos", clip.pos, nextPos);
  };

  const avoidCurrentTargetOrCursor = () => {
    const targetPoint = currentStep?.stepId
      ? targetAnchorPosition(
          { kind: "target", stepId: currentStep.stepId, placement: "top" },
          actions,
          stepTiming,
          captureRect,
        )
      : null;
    const cursorPoint =
      targetPoint ??
      resolveTextAnchorPosition(
        { ...clip, anchor: { kind: "cursor", offset: { x: 0, y: 0 } } },
        playheadMs,
        actions,
        cursorClips,
        stepTiming,
        captureRect,
      );
    setScreenPosition(avoidAnchorPosition(cursorPoint, clip.pos));
  };

  return (
    <div className="flex flex-col gap-3">
      <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
        <div>
          <SectionTitle>Text</SectionTitle>
          <SectionCopy>Preset, copy, and fast placement for the selected callout.</SectionCopy>
        </div>
        <div className={FIELD_ROW_CLASS}>
          <FieldLabel>Style</FieldLabel>
          <SelectField
            aria-label="Text style preset"
            value={clip.styleId ?? "callout"}
            onValueChange={(value) => {
              const nextStyle = value as TextStyleId;
              const defaults = styleDefaults(nextStyle);
              onSetParam(nodePath, "styleId", clip.styleId, nextStyle);
              onSetParam(nodePath, "sizePt", clip.sizePt, defaults.sizePt);
              onSetParam(nodePath, "color", clip.color, defaults.color);
              onSetParam(nodePath, "align", clip.align, defaults.align);
              onSetParam(nodePath, "boxStyle", clip.boxStyle, defaults.boxStyle);
              onSetParam(nodePath, "animation", clip.animation, defaults.animation);
            }}
            options={textStyleSelectOptions}
          />
        </div>
        <label className={FIELD_ROW_CLASS}>
          <FieldLabel>Content</FieldLabel>
          <textarea
            aria-label="Annotation text"
            value={clip.text}
            rows={3}
            onChange={(e) => onSetParam(nodePath, "text", clip.text, e.target.value)}
            className={`${FIELD_CLASS} resize-y`}
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Top", pos: { x: 0.5, y: 0.16 } },
            { label: "Center", pos: { x: 0.5, y: 0.5 } },
            { label: "Bottom", pos: { x: 0.5, y: 0.84 } },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={() => {
                setScreenPosition(item.pos);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
        <div>
          <SectionTitle>Appearance</SectionTitle>
          <SectionCopy>Keep text readable while preserving the video frame.</SectionCopy>
        </div>
        <label className={FIELD_ROW_CLASS}>
          <span className="flex items-center justify-between gap-2">
            <FieldLabel>Size</FieldLabel>
            <ValuePill>{clip.sizePt} pt</ValuePill>
          </span>
          <input
            type="range"
            aria-label="Annotation size"
            value={clip.sizePt}
            min="12"
            max="72"
            step="1"
            onChange={(e) => {
              const next = parseFiniteNumber(e.target.value, clip.sizePt);
              if (next !== clip.sizePt) {
                onSetParam(nodePath, "sizePt", clip.sizePt, next);
              }
            }}
            className={RANGE_CLASS}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <div className={FIELD_ROW_CLASS}>
            <FieldLabel>Align</FieldLabel>
            <SelectField
              aria-label="Text alignment"
              value={clip.align ?? preset.align}
              onValueChange={(value) => onSetParam(nodePath, "align", clip.align, value)}
              options={textAlignSelectOptions}
            />
          </div>
          <label className={FIELD_ROW_CLASS}>
            <FieldLabel>Color</FieldLabel>
            <input
              type="color"
              aria-label="Annotation color"
              value={color}
              onChange={(e) => onSetParam(nodePath, "color", clip.color, e.target.value)}
              className="h-10 w-full rounded-[8px] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
            />
          </label>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.56)]">
          <span>
            <span className="block text-xs font-medium text-[var(--color-fg)]">Background</span>
            <span className="text-[11px] text-[var(--color-fg-muted)]">
              Add a readable pill behind the text.
            </span>
          </span>
          <input
            type="checkbox"
            aria-label="Text background"
            checked={Boolean(boxStyle)}
            onChange={(e) =>
              onSetParam(
                nodePath,
                "boxStyle",
                clip.boxStyle,
                e.currentTarget.checked
                  ? (preset.boxStyle ?? TEXT_STYLE_PRESETS.callout.boxStyle)
                  : undefined,
              )
            }
          />
        </label>
      </fieldset>

      <details className="rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--color-fg)]">
          Advanced position and motion
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className={FIELD_ROW_CLASS}>
            <FieldLabel>Anchor</FieldLabel>
            <SelectField
              aria-label="Text anchor"
              value={anchor.kind}
              onValueChange={(value) => {
                const kind = value as TextAnchor["kind"];
                const next: TextAnchor =
                  kind === "safe-area"
                    ? { kind: "safe-area", placement: "bottom" }
                    : kind === "cursor"
                      ? { kind: "cursor", offset: { x: 0.04, y: -0.06 } }
                      : kind === "target"
                        ? { kind: "target", stepId: currentStep?.stepId ?? "", placement: "top" }
                        : { kind: "screen", pos: clip.pos };
                onSetParam(nodePath, "anchor", clip.anchor, next);
                if (next.kind === "safe-area") {
                  onSetParam(nodePath, "pos", clip.pos, safeAreaPosition(next.placement));
                } else if (next.kind === "target") {
                  const nextPos = targetAnchorPosition(next, actions, stepTiming, captureRect);
                  if (nextPos) onSetParam(nodePath, "pos", clip.pos, nextPos);
                }
              }}
              options={textAnchorKindSelectOptions}
            />
          </div>
          {anchor.kind === "target" ? (
            <div
              className={`rounded-[8px] border px-3 py-2 text-xs ${
                targetWarning
                  ? "border-amber-400/28 bg-amber-400/8 text-amber-900 dark:text-amber-100"
                  : "border-[var(--color-border-subtle)] bg-[var(--color-surface)] text-[var(--color-fg-muted)]"
              }`}
            >
              {targetWarning
                ? "Target geometry is unavailable. Preview falls back to the saved screen position."
                : `Attached to ${anchor.stepId} target ${anchor.placement}.`}
            </div>
          ) : null}
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={fitToCurrentStep}
              disabled={!currentStep}
            >
              Fit step
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={attachToCurrentTarget}
              disabled={!currentStep?.stepId}
            >
              Attach target
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON_CLASS}
              onClick={avoidCurrentTargetOrCursor}
            >
              Avoid
            </button>
          </div>
          {anchor.kind === "target" ? (
            <div className={FIELD_ROW_CLASS}>
              <FieldLabel>Target placement</FieldLabel>
              <SelectField
                aria-label="Text target placement"
                value={anchor.placement}
                onValueChange={(value) => {
                  const nextAnchor: TextAnchor = {
                    ...anchor,
                    placement: value as Extract<TextAnchor, { kind: "target" }>["placement"],
                  };
                  onSetParam(nodePath, "anchor", clip.anchor, nextAnchor);
                  const nextPos = targetAnchorPosition(
                    nextAnchor,
                    actions,
                    stepTiming,
                    captureRect,
                  );
                  if (nextPos) onSetParam(nodePath, "pos", clip.pos, nextPos);
                }}
                options={textTargetPlacementSelectOptions}
              />
            </div>
          ) : null}
          {anchor.kind === "safe-area" ? (
            <div className={FIELD_ROW_CLASS}>
              <FieldLabel>Safe placement</FieldLabel>
              <SelectField
                aria-label="Text safe-area placement"
                value={anchor.placement}
                onValueChange={(value) => {
                  const placement = value as Extract<
                    TextAnchor,
                    { kind: "safe-area" }
                  >["placement"];
                  const nextAnchor: TextAnchor = { kind: "safe-area", placement };
                  onSetParam(nodePath, "anchor", clip.anchor, nextAnchor);
                  onSetParam(nodePath, "pos", clip.pos, safeAreaPosition(placement));
                }}
                options={textSafeAreaSelectOptions}
              />
            </div>
          ) : null}
          {anchor.kind === "cursor" ? (
            <div className="grid grid-cols-2 gap-2">
              <label className={FIELD_ROW_CLASS}>
                <FieldLabel>Cursor offset X</FieldLabel>
                <input
                  type="number"
                  aria-label="Text cursor offset x"
                  value={anchor.offset.x}
                  step="0.01"
                  onChange={(e) => {
                    const next = parseFiniteNumber(e.target.value, anchor.offset.x);
                    onSetParam(nodePath, "anchor", clip.anchor, {
                      kind: "cursor",
                      offset: { ...anchor.offset, x: next },
                    });
                  }}
                  className={FIELD_CLASS}
                />
              </label>
              <label className={FIELD_ROW_CLASS}>
                <FieldLabel>Cursor offset Y</FieldLabel>
                <input
                  type="number"
                  aria-label="Text cursor offset y"
                  value={anchor.offset.y}
                  step="0.01"
                  onChange={(e) => {
                    const next = parseFiniteNumber(e.target.value, anchor.offset.y);
                    onSetParam(nodePath, "anchor", clip.anchor, {
                      kind: "cursor",
                      offset: { ...anchor.offset, y: next },
                    });
                  }}
                  className={FIELD_CLASS}
                />
              </label>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <label className={FIELD_ROW_CLASS}>
              <FieldLabel>Position X</FieldLabel>
              <input
                type="number"
                aria-label="Annotation position x"
                value={clip.pos.x}
                step="0.01"
                min="0"
                max="1"
                onChange={(e) => onPosChange("x", e.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className={FIELD_ROW_CLASS}>
              <FieldLabel>Position Y</FieldLabel>
              <input
                type="number"
                aria-label="Annotation position y"
                value={clip.pos.y}
                step="0.01"
                min="0"
                max="1"
                onChange={(e) => onPosChange("y", e.target.value)}
                className={FIELD_CLASS}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className={FIELD_ROW_CLASS}>
              <FieldLabel>In</FieldLabel>
              <SelectField
                aria-label="Text animation in"
                value={animation.in}
                onValueChange={(value) =>
                  onSetParam(nodePath, "animation", clip.animation, {
                    ...animation,
                    in: value as TextAnimationKind,
                  })
                }
                options={textAnimInSelectOptions}
              />
            </div>
            <div className={FIELD_ROW_CLASS}>
              <FieldLabel>Out</FieldLabel>
              <SelectField
                aria-label="Text animation out"
                value={animation.out}
                onValueChange={(value) =>
                  onSetParam(nodePath, "animation", clip.animation, {
                    ...animation,
                    out: value as "none" | "fade",
                  })
                }
                options={textAnimOutSelectOptions}
              />
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

function CursorParams({
  clip,
  nodePath,
  onSetParam,
  onReflow,
  compressedSegments,
}: {
  clip: CursorClip;
  nodePath: string;
  onSetParam: (nodePath: string, field: string, prev: unknown, next: unknown) => void;
  onReflow?: (motionPreset: CursorMotionPreset, preserveFullMotion: boolean) => void;
  compressedSegments?: number;
}) {
  return (
    <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
      <SectionTitle>Cursor style</SectionTitle>
      <div className={FIELD_ROW_CLASS}>
        <FieldLabel>Skin</FieldLabel>
        <SelectField
          aria-label="Cursor skin"
          value={clip.skin}
          onValueChange={(value) => onSetParam(nodePath, "skin", clip.skin, value as CursorSkin)}
          options={cursorSkinSelectOptions}
        />
      </div>
      <div className={FIELD_ROW_CLASS}>
        <FieldLabel>Motion</FieldLabel>
        <SelectField
          aria-label="Cursor motion"
          value={normalizeCursorMotionPreset(clip.motionPreset)}
          onValueChange={(value) => {
            const preset = value as CursorMotionPreset;
            if (onReflow) onReflow(preset, clip.preserveFullMotion ?? false);
            else
              onSetParam(
                nodePath,
                "motionPreset",
                normalizeCursorMotionPreset(clip.motionPreset),
                preset,
              );
          }}
          options={cursorMotionSelectOptions}
        />
      </div>
      <label className={FIELD_ROW_CLASS}>
        <span>
          <FieldLabel>Preserve full motion</FieldLabel>
          <span className="mt-1 block text-[10px] leading-4 text-[var(--color-fg-muted)]">
            Off by default. Adds an exact source hold only when motion cannot fit before input.
          </span>
        </span>
        <input
          type="checkbox"
          aria-label="Preserve full cursor motion"
          checked={clip.preserveFullMotion ?? false}
          onChange={(event) =>
            onReflow?.(normalizeCursorMotionPreset(clip.motionPreset), event.target.checked)
          }
        />
      </label>
      {!clip.preserveFullMotion && (compressedSegments ?? 0) > 0 ? (
        <p className="text-[10px] leading-4 text-[var(--color-warning,var(--color-fg-muted))]">
          {compressedSegments} movement{compressedSegments === 1 ? "" : "s"} compressed to keep
          input synchronized.
        </p>
      ) : null}
      <label className={FIELD_ROW_CLASS}>
        <span className="flex items-center justify-between gap-2">
          <FieldLabel>Size</FieldLabel>
          <ValuePill>{clip.sizeScale.toFixed(1)}x</ValuePill>
        </span>
        <input
          type="range"
          aria-label="Cursor size"
          value={clip.sizeScale}
          min="0.5"
          max="2.5"
          step="0.1"
          onChange={(e) => {
            const next = parseFiniteNumber(e.target.value, clip.sizeScale);
            if (next !== clip.sizeScale) onSetParam(nodePath, "sizeScale", clip.sizeScale, next);
          }}
          className={RANGE_CLASS}
        />
      </label>
    </fieldset>
  );
}

function SoundParams({
  clip,
  nodePath,
  onSetParam,
}: {
  clip: SoundClip;
  nodePath: string;
  onSetParam: (nodePath: string, field: string, prev: unknown, next: unknown) => void;
}) {
  return (
    <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
      <SectionTitle>Sound clip</SectionTitle>
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Path</FieldLabel>
        <input
          type="text"
          aria-label="Sound path"
          value={clip.path}
          onChange={(e) => onSetParam(nodePath, "path", clip.path, e.target.value)}
          className={FIELD_CLASS}
        />
      </label>
      <div className={FIELD_ROW_CLASS}>
        <FieldLabel>Kind</FieldLabel>
        <SelectField
          aria-label="Sound kind"
          value={clip.kind}
          onValueChange={(value) => onSetParam(nodePath, "kind", clip.kind, value as SoundKind)}
          options={soundKindSelectOptions}
        />
      </div>
      <label className={FIELD_ROW_CLASS}>
        <span className="flex items-center justify-between gap-2">
          <FieldLabel>Gain</FieldLabel>
          <ValuePill>{((clip.gain ?? 1) * 100).toFixed(0)}%</ValuePill>
        </span>
        <input
          type="range"
          aria-label="Sound gain"
          value={clip.gain ?? 1}
          min="0"
          max="2"
          step="0.05"
          onChange={(e) =>
            onSetParam(nodePath, "gain", clip.gain, parseFiniteNumber(e.target.value, 1))
          }
          className={RANGE_CLASS}
        />
      </label>
    </fieldset>
  );
}

function VideoParams({
  clip,
  nodePath,
  onSetParam,
}: {
  clip: VideoClip;
  nodePath: string;
  onSetParam: (nodePath: string, field: string, prev: unknown, next: unknown) => void;
}) {
  const transition = clip.outgoingTransition ?? { kind: "fade" as XfadeKind, durationMs: 500 };
  return (
    <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
      <SectionTitle>Transition</SectionTitle>
      <div className={FIELD_ROW_CLASS}>
        <FieldLabel>Kind</FieldLabel>
        <SelectField
          aria-label="Video transition kind"
          value={transition.kind}
          onValueChange={(value) =>
            onSetParam(nodePath, "outgoingTransition", clip.outgoingTransition, {
              ...transition,
              kind: value as XfadeKind,
            })
          }
          options={transitionKindSelectOptions}
        />
      </div>
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Duration</FieldLabel>
        <input
          type="number"
          aria-label="Video transition duration"
          value={transition.durationMs}
          min="100"
          step="100"
          onChange={(e) =>
            onSetParam(nodePath, "outgoingTransition", clip.outgoingTransition, {
              ...transition,
              durationMs: Math.max(100, parseFiniteNumber(e.target.value, 500)),
            })
          }
          className={FIELD_CLASS}
        />
      </label>
    </fieldset>
  );
}

function cloneAnnotationStyle(clip: AnnotationClip): Partial<AnnotationClip> {
  return {
    styleId: clip.styleId,
    sizePt: clip.sizePt,
    color: clip.color,
    align: clip.align,
    boxStyle: clip.boxStyle,
    animation: clip.animation,
  };
}

function clipsForLayer(tracks: TimelineSlice["tracks"], layerId: TrackId): Clip[] {
  return [...tracks[layerId]] as Clip[];
}

interface LayerTabsProps {
  activeLayer: TrackId;
  tracks: TimelineSlice["tracks"];
  onLayerChange: (layerId: TrackId) => void;
}

function LayerTabs({ activeLayer, tracks, onLayerChange }: LayerTabsProps) {
  return (
    <section className={SECTION_CLASS}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-[var(--color-fg)]">FX layers</h3>
          <p className="mt-1 text-[11px] leading-4 text-[var(--color-fg-muted)]">
            Pick a layer type first, then edit only the selected item in that layer.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1 rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-1">
        {FX_LAYER_IDS.map((layerId) => {
          const active = activeLayer === layerId;
          const count = tracks[layerId].length;
          return (
            <button
              key={layerId}
              type="button"
              aria-pressed={active}
              className={`min-w-0 cursor-pointer rounded-[6px] px-1.5 py-2 text-center transition-[background-color,color,transform] active:scale-[0.98] ${
                active
                  ? "bg-[var(--color-surface-100)] text-[var(--color-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.58)]"
                  : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-100)] hover:text-[var(--color-fg)]"
              }`}
              onClick={() => onLayerChange(layerId)}
            >
              <span className="block truncate text-[10px] font-semibold">
                {clipTypeLabel(layerId)}
              </span>
              <span className="mt-1 inline-flex rounded-full border border-[var(--color-border-subtle)] px-1.5 font-mono text-[9px] tabular-nums">
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface LayerClipListProps {
  activeLayer: TrackId;
  clips: Clip[];
  selectedClipId: string | null;
  allAnnotations: AnnotationClip[];
  onSelectClip: (clip: Clip) => void;
  pushAction: ReturnType<typeof useEditorStore.getState>["pushAction"];
}

function LayerClipList({
  activeLayer,
  clips,
  selectedClipId,
  allAnnotations,
  onSelectClip,
  pushAction,
}: LayerClipListProps) {
  const sortedClips = useMemo(() => [...clips].sort((a, b) => a.startMs - b.startMs), [clips]);
  const annotationClips = allAnnotations.filter((clip) => clip.text.trim());

  const duplicateClip = (clip: AnnotationClip) => {
    pushAction({
      kind: "add-clip",
      trackId: "annotations",
      clip: {
        ...clip,
        id: createClipId("text"),
        startMs: clip.startMs + Math.min(600, Math.max(200, clip.durationMs / 3)),
        label: `${clip.label ?? clip.text} copy`,
      },
    });
  };

  const duplicateStyle = (clip: AnnotationClip) => {
    pushAction({
      kind: "add-clip",
      trackId: "annotations",
      clip: {
        ...clip,
        ...cloneAnnotationStyle(clip),
        id: createClipId("text-style"),
        text: "Styled text",
        label: "Styled text",
        startMs: clip.startMs + Math.min(600, Math.max(200, clip.durationMs / 3)),
        anchor: { kind: "screen", pos: clip.pos },
        highlight: undefined,
      },
    });
  };

  const deleteClip = (clip: AnnotationClip) => {
    const index = allAnnotations.findIndex((item) => item.id === clip.id);
    pushAction({
      kind: "delete-clip",
      trackId: "annotations",
      clipId: clip.id,
      snapshot: clip,
      atIndex: index >= 0 ? index : undefined,
    });
  };

  const applyStyleToAll = (source: AnnotationClip) => {
    const style = cloneAnnotationStyle(source);
    annotationClips.forEach((clip) => {
      if (clip.id === source.id) return;
      const trackIndex = allAnnotations.findIndex((item) => item.id === clip.id);
      if (trackIndex < 0) return;
      Object.entries(style).forEach(([field, next]) => {
        const prev = clip[field as keyof AnnotationClip];
        if (Object.is(prev, next)) return;
        pushAction({
          kind: "set-effect-param",
          nodePath: clipNodePath("annotations", trackIndex),
          field,
          prev,
          next,
        });
      });
    });
  };

  return (
    <section className={SECTION_CLASS}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-[var(--color-fg)]">
            {clipTypeLabel(activeLayer)} layer
          </h3>
          <p className="mt-1 text-[11px] leading-4 text-[var(--color-fg-muted)]">
            {layerDescription(activeLayer)}
          </p>
        </div>
        <ValuePill>{clips.length}</ValuePill>
      </div>
      {sortedClips.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs leading-5 text-[var(--color-fg-muted)]">
          No {clipTypeLabel(activeLayer).toLowerCase()} clips yet.
        </div>
      ) : (
        <div className="space-y-2">
          {sortedClips.map((clip) => {
            const selected = selectedClipId === clip.id;
            const accent = clipTypeAccent(clip.trackId);
            return (
              <div
                key={clip.id}
                className={`rounded-[8px] border p-2 transition-[background-color,border-color,transform] ${
                  selected
                    ? "border-[var(--color-accent,#ff5b76)] bg-[var(--color-surface)] shadow-[inset_0_1px_0_rgba(255,255,255,0.58)]"
                    : "border-[var(--color-border-subtle)] bg-[var(--color-surface)]/70 hover:border-[var(--color-border)]"
                }`}
              >
                <button
                  type="button"
                  className="grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 text-left"
                  onClick={() => onSelectClip(clip)}
                >
                  <span
                    aria-hidden="true"
                    className="h-7 w-1 rounded-full"
                    style={{ background: accent }}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-[var(--color-fg)]">
                      {clipListTitle(clip)}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[10px] text-[var(--color-fg-muted)]">
                      {(clip.startMs / 1000).toFixed(2)}s · {clipListMeta(clip)}
                    </span>
                  </span>
                  <span className="rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)]">
                    {(clip.durationMs / 1000).toFixed(1)}s
                  </span>
                </button>
                {clip.trackId === "annotations" ? (
                  <div className="mt-2 grid grid-cols-4 gap-1">
                    <button
                      type="button"
                      className={TINY_BUTTON_CLASS}
                      onClick={() => duplicateClip(clip)}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className={TINY_BUTTON_CLASS}
                      onClick={() => duplicateStyle(clip)}
                    >
                      Dupe style
                    </button>
                    <button
                      type="button"
                      className={TINY_BUTTON_CLASS}
                      onClick={() => applyStyleToAll(clip)}
                    >
                      Style all
                    </button>
                    <button
                      type="button"
                      className={TINY_BUTTON_CLASS}
                      onClick={() => deleteClip(clip)}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EffectParamsBase() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const pushAction = useEditorStore((s) => s.pushAction);
  const tracks = useEditorStore((s) => s.tracks);
  const recordingActions = useEditorStore((s) => s._undoExtras?.actions ?? null);
  const setSelectedClipId = useEditorStore((s) => s.setSelectedClipId);
  const setSelectedTab = useEditorStore((s) => s.setSelectedTab);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const hit = useEditorStore(useShallow((s) => findSelectedClip(s.tracks, s.selectedClipId)));
  const [activeLayer, setActiveLayer] = useState<TrackId>(() => hit?.trackId ?? "annotations");
  const nowEditingRef = useRef<HTMLElement | null>(null);
  const companionCursor = useEditorStore(
    useShallow((s) => {
      const selected = findSelectedClip(s.tracks, s.selectedClipId);
      if (!selected || selected.trackId === "cursor") return null;
      return (
        findActiveCursorClip(s.tracks, selected.clip.startMs) ??
        findActiveCursorClip(s.tracks, s.playheadMs)
      );
    }),
  );
  const selectedTrackId = hit?.trackId;
  const activeClips = useMemo(() => clipsForLayer(tracks, activeLayer), [tracks, activeLayer]);
  const activeHit = hit?.trackId === activeLayer ? hit : null;

  useEffect(() => {
    if (selectedTrackId) setActiveLayer(selectedTrackId);
  }, [selectedTrackId]);

  const scrollNowEditingIntoView = useCallback(() => {
    window.setTimeout(() => {
      nowEditingRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 0);
  }, []);

  const selectClip = useCallback(
    (clip: Clip, options: { scrollToEditor?: boolean } = {}) => {
      setSelectedClipId(clip.id);
      setSelectedTab("effects");
      setPlayhead(clip.startMs);
      if (options.scrollToEditor) scrollNowEditingIntoView();
    },
    [scrollNowEditingIntoView, setPlayhead, setSelectedClipId, setSelectedTab],
  );

  const selectLayer = useCallback(
    (layerId: TrackId) => {
      setActiveLayer(layerId);
      const firstClip = clipsForLayer(tracks, layerId).sort((a, b) => a.startMs - b.startMs)[0];
      if (firstClip) {
        selectClip(firstClip);
      } else {
        setSelectedClipId(null);
      }
    },
    [selectClip, setSelectedClipId, tracks],
  );

  const onSetParam = useCallback(
    (nodePath: string, field: string, prev: unknown, next: unknown) => {
      if (Object.is(prev, next)) return;
      pushAction({
        kind: "set-effect-param",
        nodePath,
        field,
        prev,
        next,
      });
    },
    [pushAction],
  );

  const cursorReflow = useCallback(
    (cursor: CursorClip, motionPreset: CursorMotionPreset, preserveFullMotion: boolean) => {
      if (!recordingActions) return;
      const result = buildCursorPresetReflow({
        tracks,
        cursorClipId: cursor.id,
        actions: recordingActions,
        motionPreset,
        preserveFullMotion,
      });
      if (result) pushAction(result.action);
    },
    [pushAction, recordingActions, tracks],
  );

  if (!selectedClipId || !activeHit) {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm">
        <LayerTabs activeLayer={activeLayer} tracks={tracks} onLayerChange={selectLayer} />
        <LayerClipList
          activeLayer={activeLayer}
          clips={activeClips}
          selectedClipId={selectedClipId}
          allAnnotations={tracks.annotations}
          onSelectClip={(clip) => selectClip(clip, { scrollToEditor: true })}
          pushAction={pushAction}
        />
        <div className="rounded-[8px] border border-dashed border-[var(--color-border)] bg-[var(--color-surface-100)] p-5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ background: clipTypeAccent(activeLayer) }}
            />
            <div className="text-sm font-semibold text-[var(--color-fg)]">
              No {clipTypeLabel(activeLayer).toLowerCase()} selected
            </div>
          </div>
          <div className="mt-2 max-w-[34ch] text-xs leading-5 text-[var(--color-fg-muted)]">
            Pick a clip from the {clipTypeLabel(activeLayer).toLowerCase()} layer list above to
            reveal its controls.
          </div>
        </div>
      </div>
    );
  }

  const { trackId, clip, index } = activeHit;
  const nodePath = clipNodePath(trackId, index);
  const clipTitle = clip.label || clipListTitle(clip);
  const accent = clipTypeAccent(trackId);

  return (
    <form aria-label="Effect parameters" className="flex flex-col gap-3 p-4 text-sm">
      <LayerTabs activeLayer={activeLayer} tracks={tracks} onLayerChange={selectLayer} />
      <LayerClipList
        activeLayer={activeLayer}
        clips={activeClips}
        selectedClipId={selectedClipId}
        allAnnotations={tracks.annotations}
        onSelectClip={(clip) => selectClip(clip, { scrollToEditor: true })}
        pushAction={pushAction}
      />
      <section
        ref={nowEditingRef}
        className="rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3 shadow-[0_18px_34px_-26px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border-subtle)] pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ background: accent }}
              />
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
                Now editing
              </div>
            </div>
            <div className="mt-1 truncate text-base font-semibold text-[var(--color-fg)]">
              {clipTitle}
            </div>
          </div>
          <div className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
            {clipTypeLabel(trackId)}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2">
            <FieldLabel>Start</FieldLabel>
            <div className="mt-1 font-mono text-xs tabular-nums text-[var(--color-fg)]">
              {(clip.startMs / 1000).toFixed(3)} s
            </div>
          </div>
          <div className="rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2">
            <FieldLabel>Duration</FieldLabel>
            <div className="mt-1 font-mono text-xs tabular-nums text-[var(--color-fg)]">
              {(clip.durationMs / 1000).toFixed(3)} s
            </div>
          </div>
        </div>
        <label className={`${FIELD_ROW_CLASS} mt-3`}>
          <FieldLabel>Label</FieldLabel>
          <input
            type="text"
            aria-label="Clip label"
            value={clip.label ?? ""}
            onChange={(e) => {
              const prev = clip.label ?? "";
              const next = e.target.value;
              onSetParam(nodePath, "label", prev, next);
            }}
            className={FIELD_CLASS}
          />
        </label>
      </section>
      {clip.trackId === "zoom" ? (
        <ZoomParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      {clip.trackId === "annotations" ? (
        <AnnotationParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      {clip.trackId === "cursor" ? (
        <CursorParams
          clip={clip}
          nodePath={nodePath}
          onSetParam={onSetParam}
          onReflow={
            recordingActions
              ? (preset, preserve) => cursorReflow(clip, preset, preserve)
              : undefined
          }
          compressedSegments={
            recordingActions
              ? (buildCursorPresetReflow({
                  tracks,
                  cursorClipId: clip.id,
                  actions: recordingActions,
                  motionPreset: normalizeCursorMotionPreset(clip.motionPreset),
                  preserveFullMotion: false,
                })?.compressedSegments ?? 0)
              : 0
          }
        />
      ) : null}
      {clip.trackId !== "cursor" && companionCursor ? (
        <CursorParams
          clip={companionCursor.clip}
          nodePath={`tracks.cursor[${companionCursor.index}]`}
          onSetParam={onSetParam}
          onReflow={
            recordingActions
              ? (preset, preserve) => cursorReflow(companionCursor.clip, preset, preserve)
              : undefined
          }
          compressedSegments={
            recordingActions
              ? (buildCursorPresetReflow({
                  tracks,
                  cursorClipId: companionCursor.clip.id,
                  actions: recordingActions,
                  motionPreset: normalizeCursorMotionPreset(companionCursor.clip.motionPreset),
                  preserveFullMotion: false,
                })?.compressedSegments ?? 0)
              : 0
          }
        />
      ) : null}
      {clip.trackId === "sound" ? (
        <SoundParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      {clip.trackId === "video" ? (
        <VideoParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      <details className="group rounded-[8px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-[var(--color-fg)]">
          Parameters
          <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)] group-open:hidden">
            Show
          </span>
          <span className="hidden text-[10px] uppercase tracking-[0.14em] text-[var(--color-fg-muted)] group-open:inline">
            Hide
          </span>
        </summary>
        <pre className="max-h-40 overflow-auto border-t border-[var(--color-border-subtle)] p-3 text-[10px] leading-5 text-[var(--color-fg-muted)]">
          {JSON.stringify(clipParams(clip), null, 2)}
        </pre>
      </details>
    </form>
  );
}

export const EffectParams = memo(EffectParamsBase);

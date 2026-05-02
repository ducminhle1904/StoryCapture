/**
 * EffectParams — form for the selected clip's parameters. Common metadata
 * is always shown; typed forms are rendered for clip variants that expose
 * first-class controls. Edits dispatch structured `set-effect-param`
 * actions through the undo slice.
 */

import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEditorStore } from "../state/store";
import type {
  AnnotationClip,
  Clip,
  CursorClip,
  CursorMotionPreset,
  CursorSkin,
  SoundClip,
  SoundKind,
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
  "min-h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]";

const RANGE_CLASS = "w-full accent-[var(--color-accent,#ff5b76)]";
const SECTION_CLASS =
  "rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3";
const FIELD_ROW_CLASS = "flex flex-col gap-1.5";

const PRESET_OPTIONS: ZoomPreset[] = ["DYNAMIC", "CALM", "SUBTLE"];
const TARGET_KIND_OPTIONS: ZoomTarget["kind"][] = ["cursor", "element", "fixed-region"];
const CURSOR_SKIN_OPTIONS: CursorSkin[] = [
  "mac-default",
  "win-default",
  "dark",
  "light",
  "big-arrow",
];
const CURSOR_MOTION_LABELS: Record<CursorMotionPreset, string> = {
  natural: "Natural",
  snappy: "Snappy",
  cinematic: "Cinematic",
};
const SOUND_KIND_OPTIONS: SoundKind[] = ["bgm", "sfx", "voiceover"];
const TRANSITION_KIND_OPTIONS = XFADE_KINDS;

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
    <span className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-0.5 font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
      {children}
    </span>
  );
}

function SectionTitle({ children }: FieldLabelProps) {
  return <legend className="text-xs font-semibold text-[var(--color-fg)]">{children}</legend>;
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
      return "Annotation";
  }
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
      <SectionTitle>Zoom motion</SectionTitle>
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Target</FieldLabel>
        <select
          aria-label="Zoom target"
          value={clip.target.kind}
          onChange={(e) => {
            const next = defaultTarget(e.target.value as ZoomTarget["kind"]);
            onSetParam(nodePath, "target", clip.target, next);
          }}
          className={FIELD_CLASS}
        >
          {TARGET_KIND_OPTIONS.map((kind) => (
            <option key={kind} value={kind}>
              {labelForTargetKind(kind)}
            </option>
          ))}
        </select>
      </label>
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
      <div className="grid grid-cols-2 gap-2">
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
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Preset</FieldLabel>
        <select
          aria-label="Zoom preset"
          value={clip.preset ?? "DYNAMIC"}
          onChange={(e) =>
            onSetParam(nodePath, "preset", clip.preset, e.target.value as ZoomPreset)
          }
          className={FIELD_CLASS}
        >
          {PRESET_OPTIONS.map((preset) => (
            <option key={preset} value={preset}>
              {preset}
            </option>
          ))}
        </select>
      </label>
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
  const color = clip.color ?? "#ffffff";

  const onPosChange = (field: keyof Vec2, value: string) => {
    const next = parseFiniteNumber(value, clip.pos[field]);
    if (next !== clip.pos[field]) onSetParam(posPath, field, clip.pos[field], next);
  };

  return (
    <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
      <SectionTitle>Text overlay</SectionTitle>
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
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Color</FieldLabel>
        <input
          type="color"
          aria-label="Annotation color"
          value={color}
          onChange={(e) => onSetParam(nodePath, "color", clip.color, e.target.value)}
          className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
        />
      </label>
    </fieldset>
  );
}

function CursorParams({
  clip,
  nodePath,
  onSetParam,
}: {
  clip: CursorClip;
  nodePath: string;
  onSetParam: (nodePath: string, field: string, prev: unknown, next: unknown) => void;
}) {
  return (
    <fieldset className={`${SECTION_CLASS} flex flex-col gap-3`}>
      <SectionTitle>Cursor style</SectionTitle>
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Skin</FieldLabel>
        <select
          aria-label="Cursor skin"
          value={clip.skin}
          onChange={(e) => onSetParam(nodePath, "skin", clip.skin, e.target.value as CursorSkin)}
          className={FIELD_CLASS}
        >
          {CURSOR_SKIN_OPTIONS.map((skin) => (
            <option key={skin} value={skin}>
              {skin}
            </option>
          ))}
        </select>
      </label>
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Motion</FieldLabel>
        <select
          aria-label="Cursor motion"
          value={normalizeCursorMotionPreset(clip.motionPreset)}
          onChange={(e) =>
            onSetParam(
              nodePath,
              "motionPreset",
              normalizeCursorMotionPreset(clip.motionPreset),
              e.target.value as CursorMotionPreset,
            )
          }
          className={FIELD_CLASS}
        >
          {CURSOR_MOTION_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {CURSOR_MOTION_LABELS[preset]}
            </option>
          ))}
        </select>
      </label>
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
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Kind</FieldLabel>
        <select
          aria-label="Sound kind"
          value={clip.kind}
          onChange={(e) => onSetParam(nodePath, "kind", clip.kind, e.target.value as SoundKind)}
          className={FIELD_CLASS}
        >
          {SOUND_KIND_OPTIONS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
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
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Kind</FieldLabel>
        <select
          aria-label="Video transition kind"
          value={transition.kind}
          onChange={(e) =>
            onSetParam(nodePath, "outgoingTransition", clip.outgoingTransition, {
              ...transition,
              kind: e.target.value as XfadeKind,
            })
          }
          className={FIELD_CLASS}
        >
          {TRANSITION_KIND_OPTIONS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
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

function EffectParamsBase() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const pushAction = useEditorStore((s) => s.pushAction);
  const hit = useEditorStore(useShallow((s) => findSelectedClip(s.tracks, s.selectedClipId)));

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

  if (!selectedClipId) {
    return (
      <div className="flex min-h-64 flex-col justify-center p-4 text-sm">
        <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-100)] p-5">
          <div className="text-sm font-semibold text-[var(--color-fg)]">No clip selected</div>
          <div className="mt-2 max-w-[32ch] text-xs leading-5 text-[var(--color-fg-muted)]">
            Select a timeline clip to tune motion, text, cursor, transition, or audio details.
          </div>
        </div>
      </div>
    );
  }

  if (!hit) {
    return (
      <div className="p-4 text-sm">
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-4 text-[var(--color-fg-muted)]">
          Clip not found.
        </div>
      </div>
    );
  }

  const { trackId, clip, index } = hit;
  const nodePath = `tracks.${trackId}[${index}]`;
  const clipTitle = clip.label || clipTypeLabel(trackId);

  return (
    <form aria-label="Effect parameters" className="flex flex-col gap-3 p-4 text-sm">
      <section className="rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3 shadow-[0_18px_34px_-26px_rgba(0,0,0,0.35)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
              {clipTypeLabel(trackId)}
            </div>
            <div className="mt-1 truncate text-base font-semibold text-[var(--color-fg)]">
              {clipTitle}
            </div>
          </div>
          <div className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-fg-muted)]">
            {trackId}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2">
            <FieldLabel>Start</FieldLabel>
            <div className="mt-1 font-mono text-xs tabular-nums text-[var(--color-fg)]">
              {(clip.startMs / 1000).toFixed(3)} s
            </div>
          </div>
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2">
            <FieldLabel>Duration</FieldLabel>
            <div className="mt-1 font-mono text-xs tabular-nums text-[var(--color-fg)]">
              {(clip.durationMs / 1000).toFixed(3)} s
            </div>
          </div>
        </div>
      </section>

      <section className={SECTION_CLASS}>
        <label className={FIELD_ROW_CLASS}>
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
        <CursorParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      {clip.trackId === "sound" ? (
        <SoundParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      {clip.trackId === "video" ? (
        <VideoParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      <details className="group rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
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

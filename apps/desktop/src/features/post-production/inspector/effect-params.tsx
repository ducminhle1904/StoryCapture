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
  TimelineSlice,
  TrackId,
  Vec2,
  ZoomClip,
  ZoomPreset,
  ZoomTarget,
} from "../state/timeline-slice";
import { TRACK_IDS } from "../state/timeline-slice";

const FIELD_CLASS =
  "rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]";

const RANGE_CLASS = "w-full accent-[var(--color-accent,#ff5b76)]";

const PRESET_OPTIONS: ZoomPreset[] = ["DYNAMIC", "CALM", "SUBTLE"];
const TARGET_KIND_OPTIONS: ZoomTarget["kind"][] = ["cursor", "element", "fixed-region"];

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
    <span className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">{children}</span>
  );
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
          <label className="flex flex-col gap-1">
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
            <label className="flex flex-col gap-1">
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
            <label className="flex flex-col gap-1">
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
            <label className="flex flex-col gap-1">
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
            <label className="flex flex-col gap-1">
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
    <fieldset className="flex flex-col gap-3 border-0 p-0">
      <legend className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">Zoom</legend>
      <label className="flex flex-col gap-1">
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
      <label className="flex flex-col gap-1">
        <FieldLabel>Scale</FieldLabel>
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
        <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">
          {clip.scale.toFixed(2)}x
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
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
        <label className="flex flex-col gap-1">
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
      <label className="flex flex-col gap-1">
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
    <fieldset className="flex flex-col gap-3 border-0 p-0">
      <legend className="text-xs uppercase tracking-wide text-[var(--color-fg-muted)]">Text</legend>
      <label className="flex flex-col gap-1">
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
        <label className="flex flex-col gap-1">
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
        <label className="flex flex-col gap-1">
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
      <label className="flex flex-col gap-1">
        <FieldLabel>Size</FieldLabel>
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
        <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">{clip.sizePt} pt</span>
      </label>
      <label className="flex flex-col gap-1">
        <FieldLabel>Color</FieldLabel>
        <input
          type="color"
          aria-label="Annotation color"
          value={color}
          onChange={(e) => onSetParam(nodePath, "color", clip.color, e.target.value)}
          className="h-9 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
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
      <div className="p-4 text-sm text-[var(--color-fg-muted)]">
        Select a clip on the timeline to edit its effects.
      </div>
    );
  }

  if (!hit) {
    return <div className="p-4 text-sm text-[var(--color-fg-muted)]">Clip not found.</div>;
  }

  const { trackId, clip, index } = hit;
  const nodePath = `tracks.${trackId}[${index}]`;

  return (
    <form aria-label="Effect parameters" className="flex flex-col gap-3 p-4 text-sm">
      <div>
        <FieldLabel>Track</FieldLabel>
        <div className="text-[var(--color-fg)]">{trackId}</div>
      </div>
      <div>
        <FieldLabel>Start</FieldLabel>
        <div className="text-[var(--color-fg)] tabular-nums">
          {(clip.startMs / 1000).toFixed(3)} s
        </div>
      </div>
      <div>
        <FieldLabel>Duration</FieldLabel>
        <div className="text-[var(--color-fg)] tabular-nums">
          {(clip.durationMs / 1000).toFixed(3)} s
        </div>
      </div>
      <label className="flex flex-col gap-1">
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
      {clip.trackId === "zoom" ? (
        <ZoomParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      {clip.trackId === "annotations" ? (
        <AnnotationParams clip={clip} nodePath={nodePath} onSetParam={onSetParam} />
      ) : null}
      <div>
        <FieldLabel>Parameters</FieldLabel>
        <pre className="mt-1 max-h-32 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[10px] text-[var(--color-fg-muted)]">
          {JSON.stringify(clipParams(clip), null, 2)}
        </pre>
      </div>
    </form>
  );
}

export const EffectParams = memo(EffectParamsBase);

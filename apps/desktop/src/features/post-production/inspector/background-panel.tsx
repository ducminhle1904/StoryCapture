import { useMemo } from "react";

import gradientManifest from "../../../../../../assets/gradient-presets/manifest.json";
import {
  DEFAULT_BACKGROUND,
  type EditorBackgroundKind,
  type Rgba,
  readEditorBackground,
  useEditorStore,
} from "../state/store";

const GRADIENT_PRESETS = gradientManifest.presets.map((preset) => ({
  id: preset.id,
  label: preset.name,
}));

const DEFAULT_SOLID: Extract<EditorBackgroundKind, { kind: "solid" }> = {
  kind: "solid",
  color: { r: 16, g: 18, b: 24, a: 255 },
};

const DEFAULT_GRADIENT: Extract<EditorBackgroundKind, { kind: "gradient" }> = {
  kind: "gradient",
  preset_id: "runway-dark",
};

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgba(hex: string): Rgba {
  const clean = hex.replace(/^#/, "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return DEFAULT_SOLID.color;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
    a: 255,
  };
}

function rgbaToHex(color: Rgba): string {
  const parts = [color.r, color.g, color.b].map((n) => clampByte(n).toString(16).padStart(2, "0"));
  return `#${parts.join("")}`;
}

function solidColor(background: EditorBackgroundKind): string {
  return background.kind === "solid" ? rgbaToHex(background.color) : rgbaToHex(DEFAULT_SOLID.color);
}

function gradientPreset(background: EditorBackgroundKind): string {
  return background.kind === "gradient" ? background.preset_id : DEFAULT_GRADIENT.preset_id;
}

export function BackgroundPanel() {
  const background = useEditorStore(readEditorBackground);
  const pushAction = useEditorStore((s) => s.pushAction);

  const activeMode = background.kind;
  const solidHex = useMemo(() => solidColor(background), [background]);
  const activePreset = useMemo(() => gradientPreset(background), [background]);

  const commit = (next: EditorBackgroundKind) => {
    if (JSON.stringify(background) === JSON.stringify(next)) return;
    pushAction({
      kind: "change-background",
      prev: background,
      next,
    });
  };

  return (
    <div className="space-y-5 p-4 text-sm text-[var(--color-fg-secondary)]">
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
          Background
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-2">
        <span className="text-xs font-medium text-[var(--color-fg)]">Transparent</span>
        <input
          aria-label="Transparent background"
          type="checkbox"
          checked={activeMode === "transparent"}
          onChange={(e) => {
            commit(e.currentTarget.checked ? DEFAULT_BACKGROUND : DEFAULT_GRADIENT);
          }}
        />
      </label>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-medium text-[var(--color-fg)]">Background type</legend>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-pressed={activeMode === "solid"}
            className={`rounded-md border px-3 py-2 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
              activeMode === "solid"
                ? "border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]/12 text-[var(--color-fg)]"
                : "border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
            onClick={() => commit({ kind: "solid", color: hexToRgba(solidHex) })}
          >
            Solid
          </button>
          <button
            type="button"
            aria-pressed={activeMode === "gradient"}
            className={`rounded-md border px-3 py-2 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
              activeMode === "gradient"
                ? "border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]/12 text-[var(--color-fg)]"
                : "border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
            onClick={() => commit({ kind: "gradient", preset_id: activePreset })}
          >
            Gradient
          </button>
        </div>
      </fieldset>

      <label className="block space-y-2">
        <span className="text-xs font-medium text-[var(--color-fg)]">Solid color</span>
        <input
          aria-label="Solid background color"
          type="color"
          value={solidHex}
          className="h-10 w-full rounded-md border border-[var(--color-border)] bg-transparent p-1"
          onChange={(e) => commit({ kind: "solid", color: hexToRgba(e.currentTarget.value) })}
        />
      </label>

      <label className="block space-y-2">
        <span className="text-xs font-medium text-[var(--color-fg)]">Gradient preset</span>
        <select
          aria-label="Gradient background preset"
          value={activePreset}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
          onChange={(e) => commit({ kind: "gradient", preset_id: e.currentTarget.value })}
        >
          {GRADIENT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

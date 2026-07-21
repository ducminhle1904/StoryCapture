import {
  EXPORT_FOREGROUND_SCALE_MAX,
  EXPORT_FOREGROUND_SCALE_MIN,
} from "@storycapture/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";

import { ScSlider as Slider } from "@storycapture/ui";
import gradientManifest from "../../../../../../assets/gradient-presets/manifest.json";
import {
  DEFAULT_BACKGROUND,
  type EditorBackgroundKind,
  type Rgba,
  readEditorBackground,
  useEditorStore,
} from "../state/store";

const gradientPresetImages = import.meta.glob("../../../../../../assets/gradient-presets/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const cosmicImageAssets = import.meta.glob("../../../../../../assets/cosmic/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const glassImageAssets = import.meta.glob("../../../../../../assets/glass/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const macosImageAssets = import.meta.glob(
  [
    "../../../../../../assets/macos/*.jpg",
    "../../../../../../assets/macos/*.jpeg",
    "../../../../../../assets/macos/*.png",
  ],
  {
    eager: true,
    query: "?url",
    import: "default",
  },
) as Record<string, string>;

const GRADIENT_PRESETS = gradientManifest.presets.map((preset) => ({
  id: preset.id,
  label: preset.name,
  image: gradientPresetImages[`../../../../../../assets/gradient-presets/${preset.file}`],
}));

type BackgroundImageTab = "cosmic" | "glass" | "macos";

const IMAGE_TABS: Array<{ id: BackgroundImageTab; label: string }> = [
  { id: "cosmic", label: "Cosmic" },
  { id: "glass", label: "Glass" },
  { id: "macos", label: "macOS" },
];

function titleCase(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\bbigsur\b/gi, "big sur")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function imageEntries(
  category: BackgroundImageTab,
  labelPrefix: string,
  assets: Record<string, string>,
): Array<{ id: string; label: string; src: string }> {
  return Object.entries(assets)
    .map(([path, src]) => {
      const file = path.split("/").at(-1) ?? path;
      const stem = file.replace(/\.[^.]+$/, "");
      const suffix = stem.replace(new RegExp(`^${category}[-_]?`, "i"), "");
      const label = category === "macos" ? titleCase(stem) : `${labelPrefix} ${titleCase(suffix)}`;
      return { id: `${category}:${stem}`, label, src };
    })
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }),
    );
}

const BACKGROUND_IMAGES: Record<
  BackgroundImageTab,
  Array<{ id: string; label: string; src: string }>
> = {
  cosmic: imageEntries("cosmic", "Cosmic", cosmicImageAssets),
  glass: imageEntries("glass", "Glass", glassImageAssets),
  macos: imageEntries("macos", "macOS", macosImageAssets),
};

const DEFAULT_IMAGE =
  BACKGROUND_IMAGES.cosmic[0] ?? BACKGROUND_IMAGES.glass[0] ?? BACKGROUND_IMAGES.macos[0];

const ALL_BACKGROUND_IMAGES = Object.values(BACKGROUND_IMAGES).flat();

const DEFAULT_SOLID: Extract<EditorBackgroundKind, { kind: "solid" }> = {
  kind: "solid",
  color: { r: 16, g: 18, b: 24, a: 255 },
  foregroundScale: DEFAULT_BACKGROUND.foregroundScale,
};

const DEFAULT_GRADIENT: Extract<EditorBackgroundKind, { kind: "gradient" }> = {
  kind: "gradient",
  preset_id: "runway-dark",
  foregroundScale: DEFAULT_BACKGROUND.foregroundScale,
};

const VIDEO_SIZE_PRESETS = [
  { label: "Small", percent: 75 },
  { label: "Balanced", percent: 85 },
  { label: "Large", percent: 95 },
] as const;

const VIDEO_SIZE_FORMAT: Intl.NumberFormatOptions = {
  style: "unit",
  unit: "percent",
  unitDisplay: "narrow",
  maximumFractionDigits: 0,
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

function modeLabel(kind: EditorBackgroundKind["kind"]): string {
  if (kind === "transparent") return "Transparent";
  if (kind === "solid") return "Solid";
  if (kind === "gradient") return "Gradient";
  return "Image";
}

function imageTabForPath(path: string): BackgroundImageTab | null {
  for (const tab of IMAGE_TABS) {
    if (BACKGROUND_IMAGES[tab.id].some((image) => image.src === path)) return tab.id;
  }
  return null;
}

function imageTabForAssetId(assetId: string): BackgroundImageTab | null {
  const category = assetId.split(":", 1)[0];
  return IMAGE_TABS.some((tab) => tab.id === category) ? (category as BackgroundImageTab) : null;
}

export function BackgroundPanel() {
  const background = useEditorStore(readEditorBackground);
  const frameMode = useEditorStore((s) => s.exportForm.frameMode);
  const pushAction = useEditorStore((s) => s.pushAction);
  const setFrameMode = useEditorStore((s) => s.setExportFrameMode);
  const setForegroundScale = useEditorStore((s) => s.setForegroundScale);
  const [activeImageTab, setActiveImageTab] = useState<BackgroundImageTab>("cosmic");
  const scaleGestureStartRef = useRef<EditorBackgroundKind | null>(null);
  const keyboardScaleGestureRef = useRef(false);

  const activeMode = background.kind;
  const foregroundPercent = Math.round(background.foregroundScale * 100);
  const activeSizePreset = VIDEO_SIZE_PRESETS.find(
    (preset) => background.foregroundScale === preset.percent / 100,
  );
  const sourceFillActive = frameMode === "source";
  const solidHex = useMemo(() => solidColor(background), [background]);
  const activePreset = useMemo(() => gradientPreset(background), [background]);
  const activeGradientImage = GRADIENT_PRESETS.find((preset) => preset.id === activePreset)?.image;
  const imagePresets = BACKGROUND_IMAGES[activeImageTab];
  const backgroundImagePath = background.kind === "image" ? background.path : null;
  const backgroundImageAssetId = background.kind === "image" ? background.assetId : null;
  const selectedImage =
    (backgroundImageAssetId
      ? ALL_BACKGROUND_IMAGES.find((image) => image.id === backgroundImageAssetId)
      : null) ??
    (backgroundImagePath != null
      ? ALL_BACKGROUND_IMAGES.find((image) => image.src === backgroundImagePath)
      : null);
  const imagePreview = selectedImage?.src ?? DEFAULT_IMAGE?.src;

  useEffect(() => {
    const tab = backgroundImageAssetId
      ? imageTabForAssetId(backgroundImageAssetId)
      : backgroundImagePath == null
        ? null
        : imageTabForPath(backgroundImagePath);
    if (tab) setActiveImageTab(tab);
  }, [backgroundImageAssetId, backgroundImagePath]);

  const commit = (next: EditorBackgroundKind) => {
    if (JSON.stringify(background) === JSON.stringify(next)) return;
    pushAction({
      kind: "change-background",
      prev: background,
      next,
    });
  };

  const enableFramedSizing = () => {
    if (sourceFillActive) setFrameMode("framed");
  };

  const updateForegroundScale = (value: number | readonly number[]) => {
    if (typeof value !== "number") return;
    enableFramedSizing();
    scaleGestureStartRef.current ??= readEditorBackground(useEditorStore.getState());
    setForegroundScale(value / 100);
  };

  const finalizeForegroundScaleGesture = () => {
    const prev = scaleGestureStartRef.current;
    scaleGestureStartRef.current = null;
    if (!prev) return;
    const next = readEditorBackground(useEditorStore.getState());
    if (prev.foregroundScale === next.foregroundScale) return;
    pushAction({ kind: "change-background", prev, next });
  };

  const commitForegroundScaleGesture = (value: number | readonly number[]) => {
    if (typeof value !== "number") {
      keyboardScaleGestureRef.current = false;
      scaleGestureStartRef.current = null;
      return;
    }
    if (!keyboardScaleGestureRef.current) finalizeForegroundScaleGesture();
  };

  const isScaleKey = (key: string) =>
    [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "PageUp",
      "PageDown",
      "Home",
      "End",
    ].includes(key);

  const handleScaleKeyDown = (key: string) => {
    if (!isScaleKey(key)) return;
    keyboardScaleGestureRef.current = true;
    scaleGestureStartRef.current ??= readEditorBackground(useEditorStore.getState());
  };

  const handleScaleKeyUp = (key: string) => {
    if (!keyboardScaleGestureRef.current || !isScaleKey(key)) return;
    keyboardScaleGestureRef.current = false;
    finalizeForegroundScaleGesture();
  };

  const finishInterruptedScaleGesture = () => {
    keyboardScaleGestureRef.current = false;
    finalizeForegroundScaleGesture();
  };

  const modeButtonClass = (selected: boolean) =>
    `group grid min-h-[92px] grid-rows-[1fr_auto] overflow-hidden rounded-xl border text-left transition duration-200 ease-out active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
      selected
        ? "border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]/10 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-accent-primary)_72%,transparent)]"
        : "border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] hover:border-[color-mix(in_oklch,var(--color-fg-muted)_44%,var(--color-border-subtle))]"
    }`;

  return (
    <div className="space-y-4 p-4 text-sm text-[var(--color-fg-secondary)]">
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
              Background
            </div>
            <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Choose the canvas treatment behind the video frame.
            </div>
          </div>
          <div className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">
            {modeLabel(activeMode)}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            aria-pressed={activeMode === "transparent"}
            className={modeButtonClass(activeMode === "transparent")}
            onClick={() =>
              commit({ ...DEFAULT_BACKGROUND, foregroundScale: background.foregroundScale })
            }
          >
            <span
              aria-hidden="true"
              className="block min-h-12 border-b border-white/10"
              style={{
                backgroundColor: "var(--color-surface)",
                backgroundImage:
                  "linear-gradient(45deg, color-mix(in oklch,var(--color-fg-muted)_16%,transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in oklch,var(--color-fg-muted)_16%,transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in oklch,var(--color-fg-muted)_16%,transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in oklch,var(--color-fg-muted)_16%,transparent) 75%)",
                backgroundPosition: "0 0, 0 6px, 6px -6px, -6px 0",
                backgroundSize: "12px 12px",
              }}
            />
            <span className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-xs font-medium text-[var(--color-fg)]">Transparent</span>
              <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                Ambient
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={activeMode === "solid"}
            className={modeButtonClass(activeMode === "solid")}
            onClick={() =>
              commit({
                kind: "solid",
                color: hexToRgba(solidHex),
                foregroundScale: background.foregroundScale,
              })
            }
          >
            <span
              aria-hidden="true"
              className="block min-h-12 border-b border-white/10"
              style={{ background: solidHex }}
            />
            <span className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-xs font-medium text-[var(--color-fg)]">Solid</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-fg-muted)]">
                {solidHex}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={activeMode === "gradient"}
            className={modeButtonClass(activeMode === "gradient")}
            onClick={() =>
              commit({
                kind: "gradient",
                preset_id: activePreset,
                foregroundScale: background.foregroundScale,
              })
            }
          >
            <span
              aria-hidden="true"
              className="block min-h-12 border-b border-white/10 bg-cover bg-center"
              style={{
                backgroundImage: activeGradientImage
                  ? `url("${activeGradientImage}")`
                  : "linear-gradient(135deg, #161a20, #2b3038)",
              }}
            />
            <span className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-xs font-medium text-[var(--color-fg)]">Gradient</span>
              <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                Presets
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={activeMode === "image"}
            className={modeButtonClass(activeMode === "image")}
            disabled={!DEFAULT_IMAGE}
            onClick={() => {
              if (!DEFAULT_IMAGE) return;
              const image = selectedImage ?? DEFAULT_IMAGE;
              commit({
                kind: "image",
                assetId: image.id,
                path: image.src,
                foregroundScale: background.foregroundScale,
              });
            }}
          >
            <span
              aria-hidden="true"
              className="block min-h-12 border-b border-white/10 bg-cover bg-center"
              style={{
                backgroundImage: imagePreview ? `url("${imagePreview}")` : undefined,
              }}
            />
            <span className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-xs font-medium text-[var(--color-fg)]">Image</span>
              <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                Gallery
              </span>
            </span>
          </button>
        </div>
      </section>

      <section
        aria-labelledby="video-size-heading"
        className="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div id="video-size-heading" className="text-xs font-medium text-[var(--color-fg)]">
              Video size
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--color-fg-muted)]">
              Scale the video within the background canvas.
            </div>
          </div>
          <div className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
            {sourceFillActive ? "Source fill" : (activeSizePreset?.label ?? "Custom")}
          </div>
        </div>

        <fieldset className="grid grid-cols-3 gap-2">
          <legend className="sr-only">Video size presets</legend>
          {VIDEO_SIZE_PRESETS.map((preset) => {
            const selected = activeSizePreset?.percent === preset.percent;
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={selected}
                className={`rounded-lg border px-2 py-2 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                  selected
                    ? "border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]/10 text-[var(--color-fg)]"
                    : "border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                }`}
                onClick={() => {
                  enableFramedSizing();
                  commit({ ...background, foregroundScale: preset.percent / 100 });
                }}
              >
                <span className="block text-xs font-medium">{preset.label}</span>
                <span className="mt-0.5 block font-mono text-[10px]">{preset.percent}%</span>
              </button>
            );
          })}
        </fieldset>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span id="video-size-slider-label" className="sr-only">
              Video size percentage
            </span>
            <span className="text-xs text-[var(--color-fg-muted)]">Custom size</span>
            <output
              aria-live="polite"
              className="font-mono text-xs font-medium text-[var(--color-fg)]"
            >
              {foregroundPercent}%
            </output>
          </div>
          <Slider
            id="video-size-slider"
            aria-labelledby="video-size-slider-label"
            min={EXPORT_FOREGROUND_SCALE_MIN * 100}
            max={EXPORT_FOREGROUND_SCALE_MAX * 100}
            step={1}
            value={foregroundPercent}
            format={VIDEO_SIZE_FORMAT}
            onValueChange={updateForegroundScale}
            onValueCommitted={commitForegroundScaleGesture}
            onKeyDownCapture={(event) => handleScaleKeyDown(event.key)}
            onKeyUpCapture={(event) => handleScaleKeyUp(event.key)}
            onBlurCapture={finishInterruptedScaleGesture}
            onPointerCancelCapture={finishInterruptedScaleGesture}
            onLostPointerCapture={finishInterruptedScaleGesture}
          />
        </div>

        {sourceFillActive ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] p-2.5">
            <p className="text-xs leading-5 text-[var(--color-fg-muted)]">
              Source fill is full-bleed and currently overrides your saved {foregroundPercent}%
              size.
            </p>
            <button
              type="button"
              className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-100)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] transition hover:border-[var(--color-accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]"
              onClick={enableFramedSizing}
            >
              Use cinematic frame
            </button>
          </div>
        ) : null}
      </section>

      {activeMode === "transparent" ? (
        <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3">
          <div className="text-xs font-medium text-[var(--color-fg)]">Transparent canvas</div>
          <div className="mt-1 text-xs leading-5 text-[var(--color-fg-muted)]">
            Preview uses the live ambient backdrop while export keeps the canvas transparent.
          </div>
        </section>
      ) : null}

      {activeMode === "solid" ? (
        <label className="block space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-3">
          <span className="text-xs font-medium text-[var(--color-fg)]">Solid color</span>
          <span className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="h-7 w-7 shrink-0 rounded-md border border-[var(--color-border-subtle)]"
              style={{ background: solidHex }}
            />
            <input
              aria-label="Solid background color"
              type="color"
              value={solidHex}
              className="h-10 flex-1 rounded-lg border border-[var(--color-border)] bg-transparent p-1"
              onChange={(e) =>
                commit({
                  kind: "solid",
                  color: hexToRgba(e.currentTarget.value),
                  foregroundScale: background.foregroundScale,
                })
              }
            />
          </span>
        </label>
      ) : null}

      {activeMode === "gradient" ? (
        <fieldset className="space-y-3">
          <legend className="text-xs font-medium text-[var(--color-fg)]">Gradient presets</legend>
          <div className="grid grid-cols-2 gap-2">
            {GRADIENT_PRESETS.map((preset) => {
              const selected = activeMode === "gradient" && activePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-label={`Gradient preset ${preset.label}`}
                  aria-pressed={selected}
                  className={`group overflow-hidden rounded-lg border bg-[var(--color-surface-100)] text-left transition duration-200 ease-out active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                    selected
                      ? "border-[var(--color-accent-primary)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-accent-primary)_82%,transparent)]"
                      : "border-[var(--color-border-subtle)] hover:border-[color-mix(in_oklch,var(--color-fg-muted)_48%,var(--color-border-subtle))]"
                  }`}
                  onClick={() =>
                    commit({
                      kind: "gradient",
                      preset_id: preset.id,
                      foregroundScale: background.foregroundScale,
                    })
                  }
                >
                  <span
                    aria-hidden="true"
                    className="block h-16 border-b border-white/10 bg-cover bg-center"
                    style={{
                      backgroundImage: preset.image
                        ? `url("${preset.image}")`
                        : "linear-gradient(135deg, #161a20, #2b3038)",
                    }}
                  />
                  <span className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="truncate text-xs font-medium text-[var(--color-fg)]">
                      {preset.label}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-full transition ${
                        selected
                          ? "bg-[var(--color-accent-primary)]"
                          : "bg-[var(--color-border-subtle)] group-hover:bg-[var(--color-fg-muted)]"
                      }`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {activeMode === "image" ? (
        <fieldset className="space-y-3">
          <legend className="text-xs font-medium text-[var(--color-fg)]">Image backgrounds</legend>
          <div className="grid grid-cols-3 gap-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-1">
            {IMAGE_TABS.map((tab) => {
              const selected = activeImageTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                    selected
                      ? "bg-[var(--color-surface-200)] text-[var(--color-fg)] shadow-sm"
                      : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                  }`}
                  onClick={() => setActiveImageTab(tab.id)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {imagePresets.map((preset) => {
              const selected =
                background.kind === "image" &&
                (background.assetId === preset.id ||
                  (!background.assetId && background.path === preset.src));
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-label={`Image background ${preset.label}`}
                  aria-pressed={selected}
                  className={`group overflow-hidden rounded-lg border bg-[var(--color-surface-100)] text-left transition duration-200 ease-out active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)] ${
                    selected
                      ? "border-[var(--color-accent-primary)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-accent-primary)_82%,transparent)]"
                      : "border-[var(--color-border-subtle)] hover:border-[color-mix(in_oklch,var(--color-fg-muted)_48%,var(--color-border-subtle))]"
                  }`}
                  onClick={() =>
                    commit({
                      kind: "image",
                      assetId: preset.id,
                      path: preset.src,
                      foregroundScale: background.foregroundScale,
                    })
                  }
                >
                  <span
                    aria-hidden="true"
                    className="block h-16 border-b border-white/10 bg-cover bg-center"
                    style={{ backgroundImage: `url("${preset.src}")` }}
                  />
                  <span className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="truncate text-xs font-medium text-[var(--color-fg)]">
                      {preset.label}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-full transition ${
                        selected
                          ? "bg-[var(--color-accent-primary)]"
                          : "bg-[var(--color-border-subtle)] group-hover:bg-[var(--color-fg-muted)]"
                      }`}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

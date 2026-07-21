import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { Slider as AstryxSlider } from "@astryxdesign/core/Slider";
import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import {
  currentSystemFontCatalogResult,
  filterSystemFontCatalog,
  loadSystemFontCatalog,
  type SystemFontCatalog,
  type SystemFontCatalogResult,
  systemFontIsAvailable,
} from "../state/system-font-catalog";
import { DEFAULT_TEXT_BOX_STYLE, resolveTextStyle, TEXT_STYLE_PRESETS } from "../state/text-style";
import type {
  AnnotationClip,
  ShadowStyle,
  TextAlign,
  TextBoxStyle,
  TextFontChoice,
} from "../state/timeline-slice";

const FIELD_CLASS =
  "min-h-10 min-w-0 max-w-full rounded-[8px] border border-[var(--color-border)] bg-[var(--color-background-card)] px-3 py-2 text-sm text-[var(--color-text-primary)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent,#ff5b76)]";
const FIELD_ROW_CLASS = "flex min-w-0 max-w-full flex-col gap-1.5";

const DEFAULT_SHADOW: ShadowStyle = {
  color: "#00000099",
  blurPx: 12,
  offsetXpx: 0,
  offsetYpx: 4,
};

const BUNDLED_FONTS: TextFontChoice[] = [
  { kind: "bundled", family: "Geist", weight: 400, style: "normal" },
  { kind: "bundled", family: "Geist", weight: 500, style: "normal" },
  { kind: "bundled", family: "Geist", weight: 700, style: "normal" },
  { kind: "bundled", family: "Geist Mono", weight: 400, style: "normal" },
  { kind: "bundled", family: "Geist Mono", weight: 500, style: "normal" },
  { kind: "bundled", family: "Geist Mono", weight: 700, style: "normal" },
];

const TEXT_ALIGN_OPTIONS: TextAlign[] = ["left", "center", "right"];

type TextAppearanceField =
  | "font"
  | "sizePt"
  | "color"
  | "align"
  | "maxWidthPct"
  | "lineHeight"
  | "letterSpacingPx"
  | "textShadow"
  | "boxStyle";

interface TextAppearanceControlsProps {
  clip: AnnotationClip;
  onChange: (field: TextAppearanceField, prev: unknown, next: unknown) => void;
}

function clamp(value: string, fallback: number, min: number, max: number, step = 1): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(max, Math.max(min, parsed));
  const rounded = Math.round(bounded / step) * step;
  return Number(rounded.toFixed(step < 1 ? 4 : 0));
}

function normalizeRgb(value: string | null | undefined, fallback: string): string {
  const clean = value?.replace(/^#/, "") ?? "";
  if (/^[0-9a-f]{6}$/i.test(clean) || /^[0-9a-f]{8}$/i.test(clean)) {
    return `#${clean.slice(0, 6).toLowerCase()}`;
  }
  return fallback;
}

function colorOpacity(value: string | null | undefined): number {
  const clean = value?.replace(/^#/, "") ?? "";
  if (!/^[0-9a-f]{8}$/i.test(clean)) return 100;
  return Math.round((Number.parseInt(clean.slice(6, 8), 16) / 255) * 100);
}

function withRgb(value: string | null | undefined, rgb: string): string {
  const alpha =
    value
      ?.replace(/^#/, "")
      .match(/^[0-9a-f]{8}$/i)?.[0]
      .slice(6, 8) ?? "ff";
  return `${rgb.toLowerCase()}${alpha}`;
}

function withOpacity(value: string | null | undefined, percent: number, fallback: string): string {
  const rgb = normalizeRgb(value, fallback);
  const alpha = Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${rgb}${alpha}`;
}

function fontKey(font: TextFontChoice): string {
  if (font.kind === "system") return `system:${font.postscriptName}`;
  if (font.kind === "bundled") {
    return `bundled:${font.family}:${font.weight}:${font.style ?? "normal"}`;
  }
  return "system-default";
}

function bundledFontLabel(font: TextFontChoice): string {
  if (font.kind !== "bundled") return "System default";
  const weight = font.weight === 400 ? "Regular" : font.weight === 500 ? "Medium" : "Bold";
  return `${font.family} ${weight}`;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs font-medium text-[var(--color-text-primary)]">{children}</span>;
}

function ValuePill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-background-card)] px-2 py-0.5 font-mono text-[10px] tabular-nums text-[var(--color-text-secondary)]">
      {children}
    </span>
  );
}

function RangeField({
  label,
  ariaLabel,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className={FIELD_ROW_CLASS}>
      <span className="flex items-center justify-between gap-2">
        <FieldLabel>{label}</FieldLabel>
        <ValuePill>
          {value}
          {suffix}
        </ValuePill>
      </span>
      <AstryxSlider
        label={ariaLabel}
        isLabelHidden
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(next: number) => onChange(clamp(String(next), value, min, max, step))}
      />
    </div>
  );
}

function ShadowControls({
  label,
  ariaPrefix,
  value,
  inherited,
  onChange,
  onInherit,
}: {
  label: string;
  ariaPrefix: string;
  value: ShadowStyle | null;
  inherited: boolean;
  onChange: (value: ShadowStyle | null) => void;
  onInherit: () => void;
}) {
  const shadow = value ?? DEFAULT_SHADOW;
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-3 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-background-card)] p-3">
      <div className="flex items-center justify-between gap-3">
        <AstryxSwitch
          label={label}
          value={value !== null}
          onChange={(enabled) => onChange(enabled ? DEFAULT_SHADOW : null)}
        />
        <AstryxButton
          variant="secondary"
          size="sm"
          label={`${ariaPrefix} inherit`}
          onClick={onInherit}
        >
          Inherit
        </AstryxButton>
      </div>
      <p className="text-[10px] text-[var(--color-text-secondary)]">
        {inherited ? "Using the preset value." : value === null ? "Explicitly off." : "Custom."}
      </p>
      {value !== null ? (
        <>
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <label className={FIELD_ROW_CLASS}>
              <FieldLabel>Color</FieldLabel>
              <input
                type="color"
                aria-label={`${ariaPrefix} color`}
                value={normalizeRgb(shadow.color, "#000000")}
                onChange={(event) =>
                  onChange({ ...shadow, color: withRgb(shadow.color, event.target.value) })
                }
                className={`${FIELD_CLASS} p-1`}
              />
            </label>
            <RangeField
              label="Opacity"
              ariaLabel={`${ariaPrefix} opacity`}
              value={colorOpacity(shadow.color)}
              min={0}
              max={100}
              suffix="%"
              onChange={(opacity) =>
                onChange({ ...shadow, color: withOpacity(shadow.color, opacity, "#000000") })
              }
            />
          </div>
          <RangeField
            label="Blur"
            ariaLabel={`${ariaPrefix} blur`}
            value={shadow.blurPx}
            min={0}
            max={64}
            suffix=" px"
            onChange={(blurPx) => onChange({ ...shadow, blurPx })}
          />
          <div className="grid min-w-0 grid-cols-2 gap-2">
            <RangeField
              label="Offset X"
              ariaLabel={`${ariaPrefix} offset x`}
              value={shadow.offsetXpx}
              min={-32}
              max={32}
              suffix=" px"
              onChange={(offsetXpx) => onChange({ ...shadow, offsetXpx })}
            />
            <RangeField
              label="Offset Y"
              ariaLabel={`${ariaPrefix} offset y`}
              value={shadow.offsetYpx}
              min={-32}
              max={32}
              suffix=" px"
              onChange={(offsetYpx) => onChange({ ...shadow, offsetYpx })}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

export function TextAppearanceControls({ clip, onChange }: TextAppearanceControlsProps) {
  const resolved = resolveTextStyle(clip);
  const preset = TEXT_STYLE_PRESETS[clip.styleId ?? "callout"];
  const [catalogResult, setCatalogResult] = useState<SystemFontCatalogResult | null>(
    currentSystemFontCatalogResult,
  );
  const [loadingFonts, setLoadingFonts] = useState(false);
  const [fontQuery, setFontQuery] = useState("");
  const catalog: SystemFontCatalog | null =
    catalogResult?.status === "ready" ? catalogResult.catalog : null;
  const fontGroups = useMemo(
    () => (catalog ? filterSystemFontCatalog(catalog, fontQuery) : []),
    [catalog, fontQuery],
  );
  const selectedFontMissing =
    clip.font?.kind === "system" && catalogResult?.status === "ready"
      ? !systemFontIsAvailable(catalog, clip.font)
      : false;
  const fontOptions = useMemo(
    () => [
      ...BUNDLED_FONTS.map((font) => ({
        value: fontKey(font),
        label: bundledFontLabel(font),
      })),
      ...(clip.font?.kind === "system" && !systemFontIsAvailable(catalog, clip.font)
        ? [
            {
              value: fontKey(clip.font),
              label: selectedFontMissing ? `${clip.font.fullName} (missing)` : clip.font.fullName,
            },
          ]
        : []),
      ...fontGroups.flatMap((group) =>
        group.faces.map((font) => ({
          value: fontKey(font),
          label: `${font.fullName} — ${font.faceStyle}`,
        })),
      ),
    ],
    [catalog, clip.font, fontGroups, selectedFontMissing],
  );

  const loadFonts = async () => {
    setLoadingFonts(true);
    try {
      setCatalogResult(await loadSystemFontCatalog());
    } finally {
      setLoadingFonts(false);
    }
  };

  const chooseFont = (key: string) => {
    const bundled = BUNDLED_FONTS.find((font) => fontKey(font) === key);
    const system = catalog?.faces.find((font) => fontKey(font) === key);
    const next = bundled ?? system;
    if (next) onChange("font", clip.font, next);
  };

  const setBoxStyle = (next: TextBoxStyle | null | undefined) =>
    onChange("boxStyle", clip.boxStyle, next);
  const boxStyle = resolved.boxStyle;

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className={FIELD_ROW_CLASS}>
          <FieldLabel>Font face</FieldLabel>
          <AstryxSelector
            label="Annotation font face"
            isLabelHidden
            value={fontKey(resolved.font)}
            onChange={chooseFont}
            options={fontOptions}
          />
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
          <AstryxTextInput
            label="Search system fonts"
            isLabelHidden
            value={fontQuery}
            onChange={setFontQuery}
            placeholder="Search system fonts"
            isDisabled={!catalog}
            disabledMessage="Load system fonts before searching"
            width="100%"
          />
          <AstryxButton
            variant="secondary"
            size="sm"
            onClick={loadFonts}
            isDisabled={loadingFonts}
            label="Load system fonts"
          >
            {loadingFonts ? "Loading…" : "Load system fonts"}
          </AstryxButton>
        </div>
        {catalogResult && catalogResult.status !== "ready" ? (
          <p role="alert" className="text-xs leading-5 text-[var(--color-warning)]">
            {catalogResult.message}
          </p>
        ) : null}
        {selectedFontMissing && clip.font?.kind === "system" ? (
          <p role="alert" className="text-xs leading-5 text-[var(--color-warning)]">
            {clip.font.fullName} is no longer available. Preview and export fall back to Geist.
          </p>
        ) : null}
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-2">
        <RangeField
          label="Size"
          ariaLabel="Annotation size"
          value={resolved.sizePt}
          min={12}
          max={72}
          suffix=" pt"
          onChange={(sizePt) => onChange("sizePt", clip.sizePt, sizePt)}
        />
        <div className={FIELD_ROW_CLASS}>
          <FieldLabel>Align</FieldLabel>
          <AstryxSelector
            label="Text alignment"
            isLabelHidden
            value={resolved.align}
            onChange={(value) => onChange("align", clip.align, value as TextAlign)}
            options={TEXT_ALIGN_OPTIONS.map((align) => ({ value: align, label: align }))}
          />
        </div>
      </div>
      <label className={FIELD_ROW_CLASS}>
        <FieldLabel>Text color</FieldLabel>
        <input
          type="color"
          aria-label="Annotation color"
          value={normalizeRgb(resolved.color, "#ffffff")}
          onChange={(event) => onChange("color", clip.color, event.target.value)}
          className={`${FIELD_CLASS} p-1`}
        />
      </label>
      <RangeField
        label="Max width"
        ariaLabel="Annotation max width"
        value={resolved.maxWidthPct}
        min={20}
        max={100}
        suffix="%"
        onChange={(maxWidthPct) => onChange("maxWidthPct", clip.maxWidthPct, maxWidthPct)}
      />
      <RangeField
        label="Line height"
        ariaLabel="Annotation line height"
        value={resolved.lineHeight}
        min={0.8}
        max={2}
        step={0.05}
        suffix=""
        onChange={(lineHeight) => onChange("lineHeight", clip.lineHeight, lineHeight)}
      />
      <RangeField
        label="Letter spacing"
        ariaLabel="Annotation letter spacing"
        value={resolved.letterSpacingPx}
        min={-4}
        max={20}
        step={0.5}
        suffix=" px"
        onChange={(letterSpacingPx) =>
          onChange("letterSpacingPx", clip.letterSpacingPx, letterSpacingPx)
        }
      />

      <ShadowControls
        label="Text shadow"
        ariaPrefix="Text shadow"
        value={resolved.textShadow}
        inherited={clip.textShadow === undefined}
        onChange={(textShadow) => onChange("textShadow", clip.textShadow, textShadow)}
        onInherit={() => onChange("textShadow", clip.textShadow, undefined)}
      />

      <div className="flex min-w-0 max-w-full flex-col gap-3 rounded-[8px] border border-[var(--color-border)] bg-[var(--color-background-card)] p-3">
        <div className="flex items-center justify-between gap-3">
          <AstryxSwitch
            label="Background"
            value={boxStyle !== null}
            onChange={(enabled) =>
              setBoxStyle(enabled ? (preset.boxStyle ?? DEFAULT_TEXT_BOX_STYLE) : null)
            }
          />
          <AstryxButton
            variant="secondary"
            size="sm"
            label="Text background inherit"
            onClick={() => setBoxStyle(undefined)}
          >
            Inherit
          </AstryxButton>
        </div>
        <p className="text-[10px] text-[var(--color-text-secondary)]">
          {clip.boxStyle === undefined
            ? "Using the preset value."
            : clip.boxStyle === null
              ? "Explicitly off."
              : "Custom."}
        </p>
        {boxStyle ? (
          <>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className={FIELD_ROW_CLASS}>
                <FieldLabel>Fill color</FieldLabel>
                <input
                  type="color"
                  aria-label="Text background color"
                  value={normalizeRgb(boxStyle.bgColor, "#111317")}
                  onChange={(event) =>
                    setBoxStyle({
                      ...boxStyle,
                      bgColor: withRgb(boxStyle.bgColor, event.target.value),
                    })
                  }
                  className={`${FIELD_CLASS} p-1`}
                />
              </label>
              <RangeField
                label="Opacity"
                ariaLabel="Text background opacity"
                value={colorOpacity(boxStyle.bgColor)}
                min={0}
                max={100}
                suffix="%"
                onChange={(opacity) =>
                  setBoxStyle({
                    ...boxStyle,
                    bgColor: withOpacity(boxStyle.bgColor, opacity, "#111317"),
                  })
                }
              />
            </div>
            <RangeField
              label="Padding"
              ariaLabel="Text background padding"
              value={boxStyle.paddingPx}
              min={0}
              max={64}
              suffix=" px"
              onChange={(paddingPx) => setBoxStyle({ ...boxStyle, paddingPx })}
            />
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
              <RangeField
                label="Radius"
                ariaLabel="Text background radius"
                value={Math.min(100, boxStyle.radiusPx)}
                min={0}
                max={100}
                suffix=" px"
                onChange={(radiusPx) => setBoxStyle({ ...boxStyle, radiusPx })}
              />
              <AstryxButton
                variant="secondary"
                size="sm"
                label="Use pill text background"
                onClick={() => setBoxStyle({ ...boxStyle, radiusPx: 999 })}
              >
                Pill
              </AstryxButton>
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className={FIELD_ROW_CLASS}>
                <FieldLabel>Border color</FieldLabel>
                <input
                  type="color"
                  aria-label="Text border color"
                  value={normalizeRgb(boxStyle.borderColor, "#ffffff")}
                  onChange={(event) =>
                    setBoxStyle({
                      ...boxStyle,
                      borderColor: withRgb(boxStyle.borderColor, event.target.value),
                    })
                  }
                  className={`${FIELD_CLASS} p-1`}
                />
              </label>
              <RangeField
                label="Border"
                ariaLabel="Text border width"
                value={boxStyle.borderWidthPx}
                min={0}
                max={8}
                step={0.5}
                suffix=" px"
                onChange={(borderWidthPx) => setBoxStyle({ ...boxStyle, borderWidthPx })}
              />
            </div>
            <ShadowControls
              label="Box shadow"
              ariaPrefix="Box shadow"
              value={boxStyle.shadow}
              inherited={clip.boxStyle !== null && clip.boxStyle?.shadow === undefined}
              onChange={(shadow) => setBoxStyle({ ...boxStyle, shadow })}
              onInherit={() => setBoxStyle({ ...boxStyle, shadow: undefined })}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

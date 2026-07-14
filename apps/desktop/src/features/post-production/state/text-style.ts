import { shouldFallbackSystemFont } from "./system-font-catalog";
import type {
  AnnotationClip,
  ShadowStyle,
  TextAnimation,
  TextBoxStyle,
  TextFontChoice,
  TextFontStyle,
  TextStyleId,
  Vec2,
} from "./timeline-slice";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ResolvedTextBoxStyle {
  paddingPx: number;
  radiusPx: number;
  bgColor: string;
  borderColor: string | null;
  borderWidthPx: number;
  shadow: ShadowStyle | null;
}

export interface TextStylePreset {
  id: TextStyleId;
  label: string;
  defaultText: string;
  pos: Vec2;
  font: TextFontChoice;
  sizePt: number;
  color: string;
  align: "left" | "center" | "right";
  boxStyle: TextBoxStyle | null;
  textShadow: ShadowStyle | null;
  animation: TextAnimation;
  maxWidthPct: number;
  lineHeight: number;
  letterSpacingPx: number;
}

export interface ResolvedTextStyle extends Omit<TextStylePreset, "boxStyle"> {
  boxStyle: ResolvedTextBoxStyle | null;
}

export type TextAppearanceOverrides = Pick<
  AnnotationClip,
  | "font"
  | "sizePt"
  | "color"
  | "align"
  | "maxWidthPct"
  | "lineHeight"
  | "letterSpacingPx"
  | "textShadow"
  | "boxStyle"
>;

export const DEFAULT_TEXT_FONT: TextFontChoice = {
  kind: "bundled",
  family: "Geist",
  weight: 500,
  style: "normal",
};

export const DEFAULT_TEXT_BOX_STYLE: TextBoxStyle = {
  paddingPx: 10,
  radiusPx: 10,
  bgColor: "#111317d9",
  borderColor: null,
  borderWidthPx: 0,
  shadow: null,
};

export const TEXT_STYLE_PRESETS: Record<TextStyleId, TextStylePreset> = {
  title: {
    id: "title",
    label: "Title",
    defaultText: "Title",
    pos: { x: 0.5, y: 0.78 },
    font: { kind: "bundled", family: "Geist", weight: 700, style: "normal" },
    sizePt: 34,
    color: "#ffffff",
    align: "center",
    boxStyle: null,
    textShadow: null,
    animation: { in: "slide-up", out: "fade", durationMs: 220 },
    maxWidthPct: 72,
    lineHeight: 1.12,
    letterSpacingPx: 0,
  },
  callout: {
    id: "callout",
    label: "Callout",
    defaultText: "Callout",
    pos: { x: 0.5, y: 0.16 },
    font: { kind: "bundled", family: "Geist", weight: 700, style: "normal" },
    sizePt: 14,
    color: "#f8fafc",
    align: "center",
    boxStyle: {
      paddingPx: 10,
      radiusPx: 10,
      bgColor: "#101215e6",
      borderColor: "#ffffff2e",
      borderWidthPx: 1,
      shadow: null,
    },
    textShadow: null,
    animation: { in: "fade", out: "fade", durationMs: 180 },
    maxWidthPct: 82,
    lineHeight: 1.12,
    letterSpacingPx: 0,
  },
  "lower-third": {
    id: "lower-third",
    label: "Lower Third",
    defaultText: "Lower third",
    pos: { x: 0.18, y: 0.82 },
    font: { kind: "bundled", family: "Geist", weight: 700, style: "normal" },
    sizePt: 22,
    color: "#ffffff",
    align: "left",
    boxStyle: {
      paddingPx: 14,
      radiusPx: 14,
      bgColor: "#111317d9",
      borderColor: "#ffffff1f",
      borderWidthPx: 1,
      shadow: null,
    },
    textShadow: null,
    animation: { in: "slide-up", out: "fade", durationMs: 220 },
    maxWidthPct: 46,
    lineHeight: 1.12,
    letterSpacingPx: 0,
  },
  hotspot: {
    id: "hotspot",
    label: "Hotspot",
    defaultText: "Hotspot",
    pos: { x: 0.66, y: 0.42 },
    font: { kind: "bundled", family: "Geist", weight: 700, style: "normal" },
    sizePt: 16,
    color: "#ffffff",
    align: "left",
    boxStyle: {
      paddingPx: 10,
      radiusPx: 999,
      bgColor: "#f59e0bcc",
      borderColor: "#ffffff33",
      borderWidthPx: 1,
      shadow: null,
    },
    textShadow: null,
    animation: { in: "scale-in", out: "fade", durationMs: 180 },
    maxWidthPct: 34,
    lineHeight: 1.12,
    letterSpacingPx: 0,
  },
  caption: {
    id: "caption",
    label: "Caption",
    defaultText: "Caption",
    pos: { x: 0.5, y: 0.9 },
    font: { kind: "bundled", family: "Geist", weight: 500, style: "normal" },
    sizePt: 20,
    color: "#ffffff",
    align: "center",
    boxStyle: {
      paddingPx: 10,
      radiusPx: 10,
      bgColor: "#111317bf",
      borderColor: null,
      borderWidthPx: 0,
      shadow: null,
    },
    textShadow: null,
    animation: { in: "fade", out: "fade", durationMs: 140 },
    maxWidthPct: 78,
    lineHeight: 1.12,
    letterSpacingPx: 0,
  },
};

export const TEXT_STYLE_IDS = Object.keys(TEXT_STYLE_PRESETS) as TextStyleId[];

export function textPresetFor(clip: Pick<AnnotationClip, "styleId">): TextStylePreset {
  return TEXT_STYLE_PRESETS[clip.styleId ?? "callout"];
}

export function styleDefaults(
  styleId: TextStyleId,
): Pick<
  AnnotationClip,
  | "styleId"
  | "text"
  | "pos"
  | "font"
  | "sizePt"
  | "color"
  | "align"
  | "maxWidthPct"
  | "lineHeight"
  | "letterSpacingPx"
  | "textShadow"
  | "boxStyle"
  | "animation"
  | "anchor"
> {
  const preset = TEXT_STYLE_PRESETS[styleId];
  return {
    styleId,
    text: preset.defaultText,
    pos: preset.pos,
    font: preset.font,
    sizePt: preset.sizePt,
    color: preset.color,
    align: preset.align,
    maxWidthPct: preset.maxWidthPct,
    lineHeight: preset.lineHeight,
    letterSpacingPx: preset.letterSpacingPx,
    textShadow: preset.textShadow,
    boxStyle: preset.boxStyle,
    animation: preset.animation,
    anchor: { kind: "screen", pos: preset.pos },
  };
}

export function resolveTextStyle(clip: AnnotationClip): ResolvedTextStyle {
  const preset = textPresetFor(clip);
  return {
    ...preset,
    pos: normalizePosition(clip.pos, preset.pos),
    font: normalizeTextFontChoice(clip.font, preset.font),
    sizePt: clampNumber(clip.sizePt, 12, 72, preset.sizePt),
    color: normalizeColor(clip.color, preset.color),
    align:
      clip.align === "left" || clip.align === "right" || clip.align === "center"
        ? clip.align
        : preset.align,
    maxWidthPct: clampNumber(clip.maxWidthPct, 20, 100, preset.maxWidthPct),
    lineHeight: clampNumber(clip.lineHeight, 0.8, 2, preset.lineHeight, 0.05),
    letterSpacingPx: clampNumber(clip.letterSpacingPx, -4, 20, preset.letterSpacingPx, 0.5),
    textShadow: resolveShadow(clip.textShadow, preset.textShadow),
    boxStyle: resolveBoxStyle(clip.boxStyle, preset.boxStyle),
    animation: normalizeAnimation(clip.animation, preset.animation),
  };
}

/** Compatibility alias while callers migrate to the canonical verb form. */
export const resolvedTextStyle = resolveTextStyle;

export function appearanceOverridesFromResolved(style: ResolvedTextStyle): TextAppearanceOverrides {
  return {
    font: clone(style.font),
    sizePt: style.sizePt,
    color: style.color,
    align: style.align,
    maxWidthPct: style.maxWidthPct,
    lineHeight: style.lineHeight,
    letterSpacingPx: style.letterSpacingPx,
    textShadow: clone(style.textShadow),
    boxStyle: clone(style.boxStyle),
  };
}

export function normalizeTextFontChoice(
  value: TextFontChoice | undefined,
  fallback: TextFontChoice = DEFAULT_TEXT_FONT,
): TextFontChoice {
  if (!value || typeof value !== "object") return clone(fallback);
  if (value.kind === "system-default") return { kind: "system-default" };
  if (value.kind === "bundled" && nonEmpty(value.family)) {
    return {
      kind: "bundled",
      family: value.family.trim(),
      weight: normalizeFontWeight(value.weight, 500),
      style: normalizeFontStyle(value.style),
    };
  }
  if (
    value.kind === "system" &&
    nonEmpty(value.family) &&
    nonEmpty(value.fullName) &&
    nonEmpty(value.postscriptName)
  ) {
    return {
      kind: "system",
      family: value.family.trim(),
      fullName: value.fullName.trim(),
      postscriptName: value.postscriptName.trim(),
      faceStyle: nonEmpty(value.faceStyle) ? value.faceStyle.trim() : "Regular",
      weight: normalizeFontWeight(value.weight, 400),
      style: normalizeFontStyle(value.style),
    };
  }
  return clone(fallback);
}

export function textFontCss(font: TextFontChoice): {
  fontFamily: string;
  fontWeight: number;
  fontStyle: TextFontStyle;
} {
  const resolved = effectiveTextFontChoice(font);
  if (resolved.kind === "bundled") {
    return {
      fontFamily: `${quoteCssFontFamily(resolved.family)}, sans-serif`,
      fontWeight: resolved.weight,
      fontStyle: resolved.style ?? "normal",
    };
  }
  if (resolved.kind === "system") {
    return {
      fontFamily: `${quoteCssFontFamily(resolved.family)}, "Geist", sans-serif`,
      fontWeight: resolved.weight,
      fontStyle: resolved.style,
    };
  }
  return { fontFamily: '"Geist", sans-serif', fontWeight: 500, fontStyle: "normal" };
}

export function effectiveTextFontChoice(font: TextFontChoice): TextFontChoice {
  const resolved = normalizeTextFontChoice(font);
  return resolved.kind === "system" && shouldFallbackSystemFont(resolved)
    ? clone(DEFAULT_TEXT_FONT)
    : resolved;
}

export type TextHorizontalOrigin = "left" | "center" | "right";

export function textHorizontalOrigin(posX: number): TextHorizontalOrigin {
  if (!Number.isFinite(posX)) return "center";
  if (posX < 0.18) return "left";
  if (posX > 0.82) return "right";
  return "center";
}

export function quoteCssFontFamily(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function hexToRgbaWithAlpha(hex: string | undefined, fallback: Rgba): Rgba {
  if (!hex) return fallback;
  const clean = hex.replace(/^#/, "");
  const rgb = clean.length === 8 ? clean.slice(0, 6) : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return fallback;
  const alpha = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) : 255;
  return {
    r: parseInt(rgb.slice(0, 2), 16),
    g: parseInt(rgb.slice(2, 4), 16),
    b: parseInt(rgb.slice(4, 6), 16),
    a: Number.isFinite(alpha) ? alpha : 255,
  };
}

function resolveBoxStyle(
  value: TextBoxStyle | null | undefined,
  preset: TextBoxStyle | null,
): ResolvedTextBoxStyle | null {
  if (value === null) return null;
  const source = value ?? preset;
  if (!source) return null;
  const base = preset ?? DEFAULT_TEXT_BOX_STYLE;
  const borderColor =
    source.borderColor === null
      ? null
      : normalizeColor(
          source.borderColor,
          typeof base.borderColor === "string" ? base.borderColor : null,
        );
  return {
    paddingPx: clampNumber(source.paddingPx, 0, 64, base.paddingPx),
    radiusPx: normalizeRadius(source.radiusPx, base.radiusPx),
    bgColor: normalizeColor(
      source.bgColor,
      base.bgColor ?? DEFAULT_TEXT_BOX_STYLE.bgColor ?? "#111317d9",
    ),
    borderColor,
    borderWidthPx: clampNumber(source.borderWidthPx, 0, 8, base.borderWidthPx ?? 0, 0.5),
    shadow: resolveShadow(source.shadow, base.shadow ?? null),
  };
}

function resolveShadow(
  value: ShadowStyle | null | undefined,
  preset: ShadowStyle | null,
): ShadowStyle | null {
  if (value === null) return null;
  const source = value ?? preset;
  if (!source) return null;
  return {
    color: normalizeColor(source.color, preset?.color ?? "#00000080"),
    blurPx: clampNumber(source.blurPx, 0, 64, preset?.blurPx ?? 0, 0.5),
    offsetXpx: clampNumber(source.offsetXpx, -32, 32, preset?.offsetXpx ?? 0, 0.5),
    offsetYpx: clampNumber(source.offsetYpx, -32, 32, preset?.offsetYpx ?? 0, 0.5),
  };
}

function normalizeAnimation(
  value: TextAnimation | undefined,
  fallback: TextAnimation,
): TextAnimation {
  if (!value || typeof value !== "object") return clone(fallback);
  const animationIn = ["none", "fade", "slide-up", "scale-in"].includes(value.in)
    ? value.in
    : fallback.in;
  const animationOut = value.out === "none" || value.out === "fade" ? value.out : fallback.out;
  return {
    in: animationIn as TextAnimation["in"],
    out: animationOut,
    durationMs: clampNumber(value.durationMs, 0, 5_000, fallback.durationMs),
  };
}

function normalizePosition(value: Vec2 | undefined, fallback: Vec2): Vec2 {
  return {
    x: clampNumber(value?.x, 0, 1, fallback.x),
    y: clampNumber(value?.y, 0, 1, fallback.y),
  };
}

function normalizeRadius(value: number | undefined, fallback: number): number {
  if (value === 999) return 999;
  return clampNumber(value, 0, 100, fallback, 0.5);
}

function normalizeColor(value: string | null | undefined, fallback: string): string;
function normalizeColor(value: string | null | undefined, fallback: string | null): string | null;
function normalizeColor(value: string | null | undefined, fallback: string | null): string | null {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)
    ? value.toLowerCase()
    : fallback;
}

function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
  step?: number,
): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.min(max, Math.max(min, finite));
  if (!step) return clamped;
  const rounded = Math.round(clamped / step) * step;
  return Number(rounded.toFixed(4));
}

function normalizeFontWeight(value: number, fallback: number): number {
  return Math.round(clampNumber(value, 100, 900, fallback) / 100) * 100;
}

function normalizeFontStyle(value: TextFontStyle | undefined): TextFontStyle {
  return value === "italic" ? "italic" : "normal";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

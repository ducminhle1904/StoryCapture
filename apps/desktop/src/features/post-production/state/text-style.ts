import type { AnnotationClip, TextAnimation, TextBoxStyle, TextStyleId, Vec2 } from "./timeline-slice";
import type { FontChoice, Rgba } from "./compute-graph";

export interface TextStylePreset {
  id: TextStyleId;
  label: string;
  defaultText: string;
  pos: Vec2;
  font: FontChoice;
  sizePt: number;
  color: string;
  align: "left" | "center" | "right";
  boxStyle?: TextBoxStyle;
  animation: TextAnimation;
  maxWidthPct: number;
}

export const TEXT_STYLE_PRESETS: Record<TextStyleId, TextStylePreset> = {
  title: {
    id: "title",
    label: "Title",
    defaultText: "Title",
    pos: { x: 0.5, y: 0.78 },
    font: { kind: "bundled", family: "Geist", weight: 700 },
    sizePt: 34,
    color: "#ffffff",
    align: "center",
    animation: { in: "slide-up", out: "fade", durationMs: 220 },
    maxWidthPct: 72,
  },
  callout: {
    id: "callout",
    label: "Callout",
    defaultText: "Callout",
    pos: { x: 0.5, y: 0.16 },
    font: { kind: "bundled", family: "Geist", weight: 700 },
    sizePt: 14,
    color: "#f8fafc",
    align: "center",
    boxStyle: {
      paddingPx: 10,
      radiusPx: 10,
      bgColor: "#101215e6",
      borderColor: "#ffffff2e",
    },
    animation: { in: "fade", out: "fade", durationMs: 180 },
    maxWidthPct: 82,
  },
  "lower-third": {
    id: "lower-third",
    label: "Lower Third",
    defaultText: "Lower third",
    pos: { x: 0.18, y: 0.82 },
    font: { kind: "bundled", family: "Geist", weight: 700 },
    sizePt: 22,
    color: "#ffffff",
    align: "left",
    boxStyle: {
      paddingPx: 14,
      radiusPx: 14,
      bgColor: "#111317d9",
      borderColor: "#ffffff1f",
    },
    animation: { in: "slide-up", out: "fade", durationMs: 220 },
    maxWidthPct: 46,
  },
  hotspot: {
    id: "hotspot",
    label: "Hotspot",
    defaultText: "Hotspot",
    pos: { x: 0.66, y: 0.42 },
    font: { kind: "bundled", family: "Geist", weight: 700 },
    sizePt: 16,
    color: "#ffffff",
    align: "left",
    boxStyle: {
      paddingPx: 10,
      radiusPx: 999,
      bgColor: "#f59e0bcc",
      borderColor: "#ffffff33",
    },
    animation: { in: "scale-in", out: "fade", durationMs: 180 },
    maxWidthPct: 34,
  },
  caption: {
    id: "caption",
    label: "Caption",
    defaultText: "Caption",
    pos: { x: 0.5, y: 0.9 },
    font: { kind: "bundled", family: "Geist", weight: 500 },
    sizePt: 20,
    color: "#ffffff",
    align: "center",
    boxStyle: {
      paddingPx: 10,
      radiusPx: 10,
      bgColor: "#111317bf",
      borderColor: null,
    },
    animation: { in: "fade", out: "fade", durationMs: 140 },
    maxWidthPct: 78,
  },
};

export const TEXT_STYLE_IDS = Object.keys(TEXT_STYLE_PRESETS) as TextStyleId[];

export function textPresetFor(clip: Pick<AnnotationClip, "styleId">): TextStylePreset {
  return TEXT_STYLE_PRESETS[clip.styleId ?? "callout"];
}

export function styleDefaults(styleId: TextStyleId): Pick<
  AnnotationClip,
  "styleId" | "text" | "pos" | "sizePt" | "color" | "align" | "boxStyle" | "animation" | "anchor"
> {
  const preset = TEXT_STYLE_PRESETS[styleId];
  return {
    styleId,
    text: preset.defaultText,
    pos: preset.pos,
    sizePt: preset.sizePt,
    color: preset.color,
    align: preset.align,
    boxStyle: preset.boxStyle,
    animation: preset.animation,
    anchor: { kind: "screen", pos: preset.pos },
  };
}

export function resolvedTextStyle(clip: AnnotationClip): TextStylePreset {
  const preset = textPresetFor(clip);
  return {
    ...preset,
    pos: clip.pos,
    sizePt: clip.sizePt,
    color: clip.color ?? preset.color,
    align: clip.align ?? preset.align,
    boxStyle: clip.boxStyle ?? preset.boxStyle,
    animation: clip.animation ?? preset.animation,
  };
}

export function textFontCss(font: FontChoice): { fontFamily: string; fontWeight: number } {
  if (font.kind === "bundled") {
    return {
      fontFamily: font.family,
      fontWeight: font.weight,
    };
  }
  return {
    fontFamily: "Geist",
    fontWeight: 500,
  };
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

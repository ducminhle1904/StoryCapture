export const CURSOR_CLICK_EFFECT_STYLES = ["none", "ring", "soft-pulse", "echo", "press"] as const;
export type CursorClickEffectStyle = (typeof CURSOR_CLICK_EFFECT_STYLES)[number];

export const CURSOR_CLICK_EFFECT_COLORS = ["auto", "white", "black", "brand"] as const;
export type CursorClickEffectColor = (typeof CURSOR_CLICK_EFFECT_COLORS)[number];

export const CURSOR_CLICK_EFFECT_INTENSITIES = ["subtle", "normal", "strong"] as const;
export type CursorClickEffectIntensity = (typeof CURSOR_CLICK_EFFECT_INTENSITIES)[number];

export interface CursorClickEffectConfig {
  style: CursorClickEffectStyle;
  color: CursorClickEffectColor;
  intensity: CursorClickEffectIntensity;
}

export interface CursorClickEffectPrimitive {
  kind: "ring" | "disc";
  radius: number;
  opacity: number;
  strokeWidth: number;
  fillOpacity: number;
  glowBlur: number;
  foreground: string;
  contrast: string;
}

export interface CursorClickEffectFrame {
  durationMs: number;
  progress: number;
  cursorScale: number;
  primitives: CursorClickEffectPrimitive[];
}

export const LEGACY_CURSOR_CLICK_EFFECT: Readonly<CursorClickEffectConfig> = {
  style: "ring",
  color: "white",
  intensity: "normal",
};

export const NEW_CURSOR_CLICK_EFFECT: Readonly<CursorClickEffectConfig> = {
  style: "soft-pulse",
  color: "auto",
  intensity: "normal",
};

export const CURSOR_CLICK_EFFECT_CONTRAST_STROKE_PX = 2;
export const CURSOR_CLICK_EFFECT_MAX_ACTIVE_FEEDBACK = 3;
export const CURSOR_CLICK_EFFECT_MAX_PRIMITIVES = 2;
export const CURSOR_CLICK_EFFECT_DESIGN_WIDTH_PX = 1920;
export const CURSOR_CLICK_EFFECT_DESIGN_HEIGHT_PX = 1080;

export const CURSOR_CLICK_EFFECT_DURATIONS: Readonly<Record<CursorClickEffectStyle, number>> = {
  none: 0,
  ring: 520,
  "soft-pulse": 300,
  echo: 500,
  press: 220,
};

export const CURSOR_CLICK_EFFECT_MAX_DURATION_MS = Math.max(
  ...Object.values(CURSOR_CLICK_EFFECT_DURATIONS),
);

const INTENSITY = {
  subtle: { radius: 0.82, alpha: 0.72, stroke: 0.85, glow: 0.7, press: 0.72 },
  normal: { radius: 1, alpha: 1, stroke: 1, glow: 1, press: 1 },
  strong: { radius: 1.18, alpha: 1.15, stroke: 1.15, glow: 1.25, press: 1.18 },
} as const;

const COLORS: Readonly<Record<CursorClickEffectColor, { foreground: string; contrast: string }>> = {
  auto: { foreground: "#ffffff", contrast: "#111827" },
  white: { foreground: "#ffffff", contrast: "#111827" },
  black: { foreground: "#111827", contrast: "#ffffff" },
  brand: { foreground: "#ff5b76", contrast: "#ffffff" },
};

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function normalizeCursorClickEffect(value: unknown): CursorClickEffectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...LEGACY_CURSOR_CLICK_EFFECT };
  }
  const candidate = value as Partial<Record<keyof CursorClickEffectConfig, unknown>>;
  return {
    style: isOneOf(candidate.style, CURSOR_CLICK_EFFECT_STYLES)
      ? candidate.style
      : LEGACY_CURSOR_CLICK_EFFECT.style,
    color: isOneOf(candidate.color, CURSOR_CLICK_EFFECT_COLORS)
      ? candidate.color
      : LEGACY_CURSOR_CLICK_EFFECT.color,
    intensity: isOneOf(candidate.intensity, CURSOR_CLICK_EFFECT_INTENSITIES)
      ? candidate.intensity
      : LEGACY_CURSOR_CLICK_EFFECT.intensity,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function easeOutCubic(value: number): number {
  const t = clamp01(value);
  return 1 - (1 - t) ** 3;
}

function pressScale(progress: number, amplitude: number): number {
  if (progress <= 0.36) {
    return 1 - 0.18 * amplitude * smoothstep(progress / 0.36);
  }
  if (progress <= 0.72) {
    return 1 - 0.18 * amplitude + 0.23 * amplitude * smoothstep((progress - 0.36) / 0.36);
  }
  return 1 + 0.05 * amplitude * (1 - smoothstep((progress - 0.72) / 0.28));
}

function primitive(
  config: CursorClickEffectConfig,
  values: Omit<CursorClickEffectPrimitive, "foreground" | "contrast">,
): CursorClickEffectPrimitive {
  const intensity = INTENSITY[config.intensity];
  const color = COLORS[config.color];
  return {
    ...values,
    radius: values.radius * intensity.radius,
    opacity: clamp01(values.opacity * intensity.alpha),
    strokeWidth: values.strokeWidth * intensity.stroke,
    fillOpacity: clamp01(values.fillOpacity * intensity.alpha),
    glowBlur: values.glowBlur * intensity.glow,
    foreground: color.foreground,
    contrast: color.contrast,
  };
}

export function cursorClickEffectRenderScale(width: number, height: number): number {
  const widthScale =
    Number.isFinite(width) && width > 0 ? width / CURSOR_CLICK_EFFECT_DESIGN_WIDTH_PX : null;
  const heightScale =
    Number.isFinite(height) && height > 0 ? height / CURSOR_CLICK_EFFECT_DESIGN_HEIGHT_PX : null;
  if (widthScale != null && heightScale != null)
    return Math.max(0.01, Math.min(widthScale, heightScale));
  if (widthScale != null) return Math.max(0.01, widthScale);
  if (heightScale != null) return Math.max(0.01, heightScale);
  return 1;
}

export function sampleCursorClickEffect(
  value: unknown,
  elapsedMs: number,
): CursorClickEffectFrame | null {
  const config = normalizeCursorClickEffect(value);
  const durationMs = CURSOR_CLICK_EFFECT_DURATIONS[config.style];
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || durationMs <= 0 || elapsedMs > durationMs) {
    return null;
  }

  const progress = clamp01(elapsedMs / durationMs);
  const fade = 1 - smoothstep(progress);
  let cursorScale = 1;
  let primitives: CursorClickEffectPrimitive[] = [];

  if (config.style === "ring") {
    primitives = [
      primitive(config, {
        kind: "ring",
        radius: 9 + 39 * easeOutCubic(progress),
        opacity: 0.72 * fade,
        strokeWidth: 2,
        fillOpacity: 0.08 * fade,
        glowBlur: 9,
      }),
    ];
  } else if (config.style === "soft-pulse") {
    const pulseFade = Math.sin(Math.PI * progress);
    primitives = [
      primitive(config, {
        kind: "disc",
        radius: 16 + 18 * easeOutCubic(progress),
        opacity: 0.34 * pulseFade,
        strokeWidth: 1.5,
        fillOpacity: 0.2 * pulseFade,
        glowBlur: 12,
      }),
    ];
  } else if (config.style === "echo") {
    const echoDurationMs = durationMs - 90;
    primitives = [0, 90].flatMap((delayMs) => {
      const phase = (elapsedMs - delayMs) / echoDurationMs;
      if (phase < 0 || phase > 1) return [];
      const phaseFade = 1 - smoothstep(phase);
      return [
        primitive(config, {
          kind: "ring",
          radius: 10 + 40 * easeOutCubic(phase),
          opacity: 0.64 * phaseFade,
          strokeWidth: 1.8,
          fillOpacity: 0.03 * phaseFade,
          glowBlur: 7,
        }),
      ];
    });
  } else if (config.style === "press") {
    const intensity = INTENSITY[config.intensity];
    cursorScale = pressScale(progress, intensity.press);
    primitives = [
      primitive(config, {
        kind: "disc",
        radius: 13 + 8 * easeOutCubic(progress),
        opacity: 0.3 * fade,
        strokeWidth: 1.4,
        fillOpacity: 0.15 * fade,
        glowBlur: 8,
      }),
    ];
  }

  return { durationMs, progress, cursorScale, primitives };
}

import { describe, expect, it } from "vitest";
import {
  CURSOR_CLICK_EFFECT_DURATIONS,
  CURSOR_CLICK_EFFECT_MAX_DURATION_MS,
  cursorClickEffectRenderScale,
  LEGACY_CURSOR_CLICK_EFFECT,
  NEW_CURSOR_CLICK_EFFECT,
  normalizeCursorClickEffect,
  sampleCursorClickEffect,
} from "../cursor-click-effect";

describe("cursor click effects", () => {
  it("normalizes missing and invalid values to the legacy preset", () => {
    expect(normalizeCursorClickEffect(undefined)).toEqual(LEGACY_CURSOR_CLICK_EFFECT);
    expect(normalizeCursorClickEffect({ style: "burst", color: 42, intensity: "huge" })).toEqual(
      LEGACY_CURSOR_CLICK_EFFECT,
    );
    expect(NEW_CURSOR_CLICK_EFFECT).toEqual({
      style: "soft-pulse",
      color: "auto",
      intensity: "normal",
    });
  });

  it.each([
    "ring",
    "soft-pulse",
    "echo",
    "press",
  ] as const)("samples %s deterministically at start, middle, and end", (style) => {
    const config = { style, color: "brand", intensity: "normal" } as const;
    const duration = CURSOR_CLICK_EFFECT_DURATIONS[style];
    const start = sampleCursorClickEffect(config, 0);
    const middle = sampleCursorClickEffect(config, duration / 2);
    const end = sampleCursorClickEffect(config, duration);

    expect(start?.progress).toBe(0);
    expect(middle?.progress).toBe(0.5);
    expect(end?.progress).toBe(1);
    expect(start?.primitives.length).toBeGreaterThan(0);
    expect(end?.cursorScale).toBe(1);
    expect(sampleCursorClickEffect(config, duration + 1)).toBeNull();
  });

  it("returns no frame for None or invalid elapsed time", () => {
    expect(
      sampleCursorClickEffect({ style: "none", color: "white", intensity: "normal" }, 0),
    ).toBeNull();
    expect(sampleCursorClickEffect(LEGACY_CURSOR_CLICK_EFFECT, Number.NaN)).toBeNull();
    expect(sampleCursorClickEffect(LEGACY_CURSOR_CLICK_EFFECT, -1)).toBeNull();
  });

  it("stages Echo primitives without timers", () => {
    const config = { style: "echo", color: "black", intensity: "strong" } as const;
    expect(sampleCursorClickEffect(config, 0)?.primitives).toHaveLength(1);
    expect(sampleCursorClickEffect(config, 90)?.primitives).toHaveLength(2);
  });

  it("derives the max duration and render scale from shared preset/design data", () => {
    expect(CURSOR_CLICK_EFFECT_MAX_DURATION_MS).toBe(
      Math.max(...Object.values(CURSOR_CLICK_EFFECT_DURATIONS)),
    );
    expect(cursorClickEffectRenderScale(1920, 1080)).toBe(1);
    expect(cursorClickEffectRenderScale(1440, 1080)).toBe(0.75);
    expect(cursorClickEffectRenderScale(1080, 1080)).toBe(0.5625);
  });

  it("applies intensity to filled primitives as well as strokes", () => {
    const subtle = sampleCursorClickEffect(
      { style: "soft-pulse", color: "auto", intensity: "subtle" },
      150,
    );
    const strong = sampleCursorClickEffect(
      { style: "soft-pulse", color: "auto", intensity: "strong" },
      150,
    );

    expect(subtle?.primitives[0]?.fillOpacity).toBeLessThan(
      strong?.primitives[0]?.fillOpacity ?? 0,
    );
  });
});

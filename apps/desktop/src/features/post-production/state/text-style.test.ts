import { beforeEach, describe, expect, it } from "vitest";

import { clearSystemFontCatalogCache, loadSystemFontCatalog } from "./system-font-catalog";
import { appearanceOverridesFromResolved, resolveTextStyle, textFontCss } from "./text-style";
import type { AnnotationClip } from "./timeline-slice";

function annotation(patch: Partial<AnnotationClip> = {}): AnnotationClip {
  return {
    id: "annotation-1",
    trackId: "annotations",
    startMs: 0,
    durationMs: 1_000,
    text: "Hello",
    pos: { x: 0.5, y: 0.5 },
    sizePt: 14,
    styleId: "callout",
    ...patch,
  };
}

describe("resolveTextStyle", () => {
  beforeEach(() => clearSystemFontCatalogCache());

  it("inherits undefined fields and treats null as an explicit off state", () => {
    const inherited = resolveTextStyle(annotation());
    const disabled = resolveTextStyle(annotation({ boxStyle: null, textShadow: null }));

    expect(inherited.boxStyle).toMatchObject({
      bgColor: "#101215e6",
      borderWidthPx: 1,
      shadow: null,
    });
    expect(disabled.boxStyle).toBeNull();
    expect(disabled.textShadow).toBeNull();
  });

  it("clamps malformed persisted numeric values at the shared boundary", () => {
    const style = resolveTextStyle(
      annotation({
        sizePt: Number.POSITIVE_INFINITY,
        maxWidthPct: 5,
        lineHeight: 9,
        letterSpacingPx: -20,
        textShadow: { color: "bad", blurPx: 100, offsetXpx: -99, offsetYpx: 99 },
        boxStyle: {
          paddingPx: 200,
          radiusPx: 999,
          bgColor: "nope",
          borderColor: "#abcdef80",
          borderWidthPx: 12,
          shadow: { color: "#00000080", blurPx: -1, offsetXpx: 40, offsetYpx: -40 },
        },
      }),
    );

    expect(style).toMatchObject({
      sizePt: 14,
      maxWidthPct: 20,
      lineHeight: 2,
      letterSpacingPx: -4,
      textShadow: { color: "#00000080", blurPx: 64, offsetXpx: -32, offsetYpx: 32 },
      boxStyle: {
        paddingPx: 64,
        radiusPx: 999,
        bgColor: "#101215e6",
        borderColor: "#abcdef80",
        borderWidthPx: 8,
        shadow: { blurPx: 0, offsetXpx: 32, offsetYpx: -32 },
      },
    });
  });

  it("keeps system font metadata while producing a safely quoted CSS fallback stack", () => {
    const style = resolveTextStyle(
      annotation({
        font: {
          kind: "system",
          family: 'ACME "Display"',
          fullName: "ACME Display Italic",
          postscriptName: "ACMEDisplay-Italic",
          faceStyle: "Italic",
          weight: 450,
          style: "italic",
        },
      }),
    );

    expect(style.font).toMatchObject({
      kind: "system",
      postscriptName: "ACMEDisplay-Italic",
      weight: 500,
      style: "italic",
    });
    expect(textFontCss(style.font)).toEqual({
      fontFamily: '"ACME \\"Display\\"", "Geist", sans-serif',
      fontWeight: 500,
      fontStyle: "italic",
    });
  });

  it("preserves denied system-font metadata while rendering with the bundled fallback", async () => {
    const style = resolveTextStyle(
      annotation({
        font: {
          kind: "system",
          family: "Unavailable Sans",
          fullName: "Unavailable Sans Regular",
          postscriptName: "UnavailableSans-Regular",
          faceStyle: "Regular",
          weight: 400,
          style: "normal",
        },
      }),
    );

    await loadSystemFontCatalog({
      queryLocalFonts: async () => {
        throw { name: "NotAllowedError" };
      },
    } as unknown as Window);

    expect(style.font).toMatchObject({
      kind: "system",
      postscriptName: "UnavailableSans-Regular",
    });
    expect(textFontCss(style.font)).toEqual({
      fontFamily: '"Geist", sans-serif',
      fontWeight: 500,
      fontStyle: "normal",
    });
  });

  it("copies only resolved appearance for bulk application", () => {
    const style = resolveTextStyle(annotation({ maxWidthPct: 55, letterSpacingPx: 2 }));
    const appearance = appearanceOverridesFromResolved(style);

    expect(appearance).toMatchObject({ maxWidthPct: 55, letterSpacingPx: 2, sizePt: 14 });
    expect(appearance).not.toHaveProperty("styleId");
    expect(appearance).not.toHaveProperty("text");
    expect(appearance).not.toHaveProperty("animation");
  });
});

import { describe, expect, it } from "vitest";

import { canonicalCursorPngFramePath } from "./canonical-assets";

describe("canonical cursor PNG asset identity", () => {
  it("resolves printf, token, explicit file, and directory paths deterministically", () => {
    expect(canonicalCursorPngFramePath("/frames/frame-%06d.png", 12)).toBe(
      "/frames/frame-000012.png",
    );
    expect(canonicalCursorPngFramePath("/frames/{frame}.png", 7)).toBe("/frames/000007.png");
    expect(canonicalCursorPngFramePath("/frames/static.png", 3)).toBe("/frames/static.png");
    expect(canonicalCursorPngFramePath("/frames", 42)).toBe("/frames/frame-000042.png");
  });
});

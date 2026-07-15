import { describe, expect, it, vi } from "vitest";

import {
  CanonicalImageAssetPool,
  canonicalCursorPngFramePath,
  resolveCanonicalImageSrc,
} from "./canonical-assets";
import { canonicalGraph } from "./canonical-test-fixture";

describe("canonical image source provenance", () => {
  it.each([
    "/@fs/Users/example/StoryCapture/apps/desktop/assets/cursor-skins/mac-default.png",
    "data:image/png;base64,AAAA",
    "./assets/big-arrow-D5yB2.png",
    "file:///Applications/StoryCapture.app/Contents/Resources/assets/big-arrow.png",
  ])("preserves bundled URL %s", (path) => {
    expect(resolveCanonicalImageSrc(path, "bundled-url")).toBe(path);
  });

  it("routes graph paths through the canonical asset protocol", () => {
    expect(resolveCanonicalImageSrc("/tmp/project/background.png", "graph-path")).toBe(
      "storycapture-asset://local/%2Ftmp%2Fproject%2Fbackground.png",
    );
  });

  it("passes explicit provenance for graph assets and bundled cursor skins", async () => {
    const image = { width: 32, height: 32 } as unknown as CanvasImageSource;
    const loader = vi.fn(async () => image);
    const pool = new CanonicalImageAssetPool(loader);

    try {
      await pool.configure(
        canonicalGraph([
          {
            type: "background",
            id: "background",
            kind: {
              kind: "image",
              asset_id: "background-image",
              path: "/tmp/project/background.png",
            },
            radius_px: 0,
            shadow: null,
            padding_px: 0,
          },
          {
            type: "cursor-overlay",
            id: "cursor",
            clip_id: "cursor-clip",
            skin: "mac-default",
            size_scale: 1,
            motion_preset: "natural",
            preserve_full_motion: true,
            click_effect: { style: "none", color: "auto", intensity: "normal" },
            color_tint: null,
            t_start_ms: 0,
            duration_ms: 1_000,
            trajectory: {
              kind: "actions",
              path: "/tmp/project/actions.json",
              png_sequence_dir: "/tmp/project/actions.json",
              fps: 60,
              frame_count: 60,
            },
          },
        ]),
      );

      expect(loader).toHaveBeenCalledWith("/tmp/project/background.png", "graph-path");
      expect(loader).toHaveBeenCalledWith(expect.any(String), "bundled-url");
      expect(pool.cursorSkin("mac-default")).toBe(image);
    } finally {
      pool.dispose();
    }
  });
});

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

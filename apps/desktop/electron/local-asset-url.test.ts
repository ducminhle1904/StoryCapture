import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assetPathFromUrl,
  convertLocalAssetPath,
  isAllowedLocalAssetPath,
  isPathUnderRoot,
} from "./local-asset-url";

describe("local asset URL helpers", () => {
  it("converts absolute local paths to the app asset scheme", () => {
    const filePath = path.join(path.sep, "Users", "locvotuan", "Library", "app", "frame 1.png");
    const url = convertLocalAssetPath(filePath);

    expect(url.startsWith("storycapture-asset://local/")).toBe(true);
    expect(assetPathFromUrl(url)).toBe(filePath);
  });

  it("preserves URLs already controlled by a protocol", () => {
    expect(convertLocalAssetPath("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
    expect(convertLocalAssetPath("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
    expect(convertLocalAssetPath("blob:http://localhost/blob-id")).toBe(
      "blob:http://localhost/blob-id",
    );
    expect(convertLocalAssetPath("asset://icons/logo.png")).toBe("asset://icons/logo.png");
    expect(convertLocalAssetPath("storycapture-asset://local/%2Ftmp%2Fa.png")).toBe(
      "storycapture-asset://local/%2Ftmp%2Fa.png",
    );
  });

  it("allows files inside configured roots and rejects sibling prefixes", () => {
    const root = path.join(path.sep, "Users", "locvotuan", "StoryCapture");
    expect(isPathUnderRoot(path.join(root, "demo", "frame.png"), root)).toBe(true);
    expect(isPathUnderRoot(path.join(root, "..", "StoryCapture-other", "frame.png"), root)).toBe(
      false,
    );
    expect(isAllowedLocalAssetPath(path.join(root, "demo", "frame.png"), [root])).toBe(true);
    expect(isAllowedLocalAssetPath(path.join(path.sep, "tmp", "frame.png"), [root])).toBe(false);
  });
});

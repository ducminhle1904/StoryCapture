import { describe, expect, it } from "vitest";

import { bundledBackgroundAssetIdFromPath } from "./background-asset";

describe("bundledBackgroundAssetIdFromPath", () => {
  it.each([
    ["/assets/8-AbCd1234.jpg", "cosmic:8"],
    ["/assets/glass-10-XyZ12345.jpg", "glass:glass-10"],
    ["/assets/bigsur-dark-QwEr1234.jpg", "macos:bigsur-dark"],
    ["/assets/sequoia-dark-A1b2C3d4.jpeg", "macos:sequoia-dark"],
    ["/assets/photo-1702539336564-b37d0f3276e7.png", "macos:photo-1702539336564-b37d0f3276e7"],
  ])("maps legacy Vite URL %s to %s", (path, expected) => {
    expect(bundledBackgroundAssetIdFromPath(path)).toBe(expected);
  });

  it("does not claim an arbitrary user image", () => {
    expect(bundledBackgroundAssetIdFromPath("/Users/me/Pictures/custom.jpg")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { resolveCursorSyncMode } from "./cursor-sync-mode";

describe("resolveCursorSyncMode", () => {
  it.each(["legacy", "shadow", "unified"] as const)("accepts %s", (mode) => {
    expect(resolveCursorSyncMode(mode)).toBe(mode);
  });

  it.each([undefined, "", "future", "UNIFIED"])("defaults invalid value %s to shadow", (value) => {
    expect(resolveCursorSyncMode(value)).toBe("shadow");
  });
});

// Unit tests for toPlaywrightKey — the renderer KeyboardEvent → Playwright
// keyboard string mapper used by author.dispatchInput keyboard variants.

import { describe, expect, it } from "vitest";
import { toPlaywrightKey } from "./server.mjs";

describe("toPlaywrightKey", () => {
  it("returns lowercase letter for a character key", () => {
    expect(toPlaywrightKey({ key: "a", code: "KeyA" })).toBe("a");
  });

  it("returns shifted character (preserves case from key)", () => {
    expect(toPlaywrightKey({ key: "A", code: "KeyA" })).toBe("A");
  });

  it("returns code for modifier keys (layout-independent)", () => {
    expect(toPlaywrightKey({ key: "Shift", code: "ShiftLeft" })).toBe("ShiftLeft");
    expect(toPlaywrightKey({ key: "Control", code: "ControlRight" })).toBe(
      "ControlRight",
    );
    expect(toPlaywrightKey({ key: "Meta", code: "MetaLeft" })).toBe("MetaLeft");
    expect(toPlaywrightKey({ key: "Alt", code: "AltLeft" })).toBe("AltLeft");
  });

  it("returns code for navigation/edit keys", () => {
    expect(toPlaywrightKey({ key: "Tab", code: "Tab" })).toBe("Tab");
    expect(toPlaywrightKey({ key: "Enter", code: "Enter" })).toBe("Enter");
    expect(toPlaywrightKey({ key: "Escape", code: "Escape" })).toBe("Escape");
    expect(toPlaywrightKey({ key: "Backspace", code: "Backspace" })).toBe(
      "Backspace",
    );
    expect(toPlaywrightKey({ key: "Delete", code: "Delete" })).toBe("Delete");
    expect(toPlaywrightKey({ key: "Home", code: "Home" })).toBe("Home");
    expect(toPlaywrightKey({ key: "End", code: "End" })).toBe("End");
  });

  it("returns code for arrow keys", () => {
    expect(toPlaywrightKey({ key: "ArrowLeft", code: "ArrowLeft" })).toBe(
      "ArrowLeft",
    );
    expect(toPlaywrightKey({ key: "ArrowUp", code: "ArrowUp" })).toBe("ArrowUp");
  });

  it("returns code for page/function keys", () => {
    expect(toPlaywrightKey({ key: "PageUp", code: "PageUp" })).toBe("PageUp");
    expect(toPlaywrightKey({ key: "F1", code: "F1" })).toBe("F1");
    expect(toPlaywrightKey({ key: "F12", code: "F12" })).toBe("F12");
  });

  it("returns key for digits and symbols (key carries shifted form)", () => {
    expect(toPlaywrightKey({ key: "1", code: "Digit1" })).toBe("1");
    expect(toPlaywrightKey({ key: "@", code: "Digit2" })).toBe("@");
  });

  it("falls back to code when key is missing", () => {
    expect(toPlaywrightKey({ key: "", code: "KeyA" })).toBe("KeyA");
  });

  it("returns null for empty / invalid input", () => {
    expect(toPlaywrightKey(null)).toBeNull();
    expect(toPlaywrightKey({})).toBeNull();
    expect(toPlaywrightKey({ key: "", code: "" })).toBeNull();
  });
});

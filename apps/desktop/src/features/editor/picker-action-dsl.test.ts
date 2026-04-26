import { describe, expect, it } from "vitest";

import type { PickLocator } from "@/ipc/picker";

import { parseLine } from "./picker-emit-rewrite";
import {
  buildPickerActionLine,
  escapeDslString,
  formatPickedTarget,
  inferDefaultAction,
} from "./picker-action-dsl";

const roleSave: PickLocator = {
  kind: "role",
  value: { role: "button", name: "Save" },
};
const testidSave: PickLocator = { kind: "testid", value: "save" };

describe("escapeDslString", () => {
  it("escapes backslash and double quote", () => {
    expect(escapeDslString('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe("formatPickedTarget", () => {
  it("formats testid", () => {
    expect(formatPickedTarget(testidSave)).toBe('testid "save"');
  });
  it("formats role + accessible name", () => {
    expect(formatPickedTarget(roleSave)).toBe('button "Save"');
  });
  it("formats label as field", () => {
    expect(formatPickedTarget({ kind: "label", value: "Email" })).toBe(
      'field "Email"',
    );
  });
  it("formats text_exact and text identically", () => {
    expect(formatPickedTarget({ kind: "text_exact", value: "Docs" })).toBe(
      'text "Docs"',
    );
    expect(formatPickedTarget({ kind: "text", value: "Docs" })).toBe(
      'text "Docs"',
    );
  });
  it("formats selector and aria", () => {
    expect(formatPickedTarget({ kind: "selector", value: "#save" })).toBe(
      'selector "#save"',
    );
    expect(formatPickedTarget({ kind: "aria", value: "Save" })).toBe(
      'aria "Save"',
    );
  });
  it("escapes embedded quotes in value", () => {
    expect(
      formatPickedTarget({ kind: "testid", value: 'a"b' }),
    ).toBe('testid "a\\"b"');
  });
  it("throws when role locator is malformed", () => {
    expect(() =>
      formatPickedTarget({ kind: "role", value: "not-a-shape" } as PickLocator),
    ).toThrow(/role locator/);
  });
});

describe("buildPickerActionLine", () => {
  it("builds click", () => {
    expect(buildPickerActionLine("click", roleSave)).toBe('click button "Save"');
  });
  it("builds hover", () => {
    expect(buildPickerActionLine("hover", roleSave)).toBe('hover button "Save"');
  });
  it("builds assert", () => {
    expect(buildPickerActionLine("assert", roleSave)).toBe(
      'assert button "Save"',
    );
  });
  it("builds wait-for with default 5s timeout", () => {
    expect(buildPickerActionLine("wait-for", roleSave)).toBe(
      'wait-for button "Save" timeout 5s',
    );
  });
  it("preserves indent from parsed line", () => {
    expect(
      buildPickerActionLine(
        "click",
        roleSave,
        parseLine('    hover field "Old"'),
      ),
    ).toBe('    click button "Save"');
  });
  it("preserves existing wait-for timeout when action is wait-for", () => {
    expect(
      buildPickerActionLine(
        "wait-for",
        roleSave,
        parseLine('    wait-for text "Old" timeout 10s'),
      ),
    ).toBe('    wait-for button "Save" timeout 10s');
  });
  it("falls back to default timeout when parsed line is not wait-for", () => {
    expect(
      buildPickerActionLine(
        "wait-for",
        roleSave,
        parseLine('    click text "Old"'),
      ),
    ).toBe('    wait-for button "Save" timeout 5s');
  });
});

describe("inferDefaultAction", () => {
  it.each([
    ['hover button "Save"', "hover"],
    ['wait-for button "Save" timeout 5s', "wait-for"],
    ['assert button "Save"', "assert"],
    ['click button "Save"', "click"],
    ["", "click"],
    ['type field "X" with "y"', "click"],
  ] as const)("%s -> %s", (line, expected) => {
    expect(inferDefaultAction(line)).toBe(expected);
  });
});

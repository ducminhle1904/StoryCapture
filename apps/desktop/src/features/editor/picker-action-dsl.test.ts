import { describe, expect, it } from "vitest";

import type { PickElementMeta, PickLocator } from "@/ipc/picker";

import { parseLine } from "./picker-emit-rewrite";
import {
  buildPickerActionLine,
  escapeDslString,
  formatPickedTarget,
  getPickerActionItems,
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
    ['fill field "Email" with "alice@example.com"', "fill"],
    ['type field "Email" "alice"', "type"],
    ['select field "Country" "USA"', "select"],
    ['upload selector "input[type=file]" "/tmp/x.png"', "upload"],
    ['drag testid "src" to testid "dst"', "drag"],
    ['unknown-verb field "x"', "click"],
  ] as const)("%s -> %s", (line, expected) => {
    expect(inferDefaultAction(line)).toBe(expected);
  });
});

describe("buildPickerActionLine — input actions", () => {
  const fieldEmail: PickLocator = { kind: "label", value: "Email" };
  const selectorFile: PickLocator = {
    kind: "selector",
    value: "input[type=file]",
  };

  it("builds fill with text", () => {
    expect(
      buildPickerActionLine("fill", fieldEmail, undefined, {
        text: "alice@example.com",
      }),
    ).toBe('fill field "Email" with "alice@example.com"');
  });

  it("builds type with text", () => {
    expect(
      buildPickerActionLine("type", fieldEmail, undefined, { text: "alice" }),
    ).toBe('type field "Email" "alice"');
  });

  it("builds select with value", () => {
    expect(
      buildPickerActionLine(
        "select",
        { kind: "label", value: "Country" },
        undefined,
        { value: "USA" },
      ),
    ).toBe('select field "Country" "USA"');
  });

  it("builds upload with path", () => {
    expect(
      buildPickerActionLine("upload", selectorFile, undefined, {
        path: "/tmp/photo.png",
      }),
    ).toBe('upload selector "input[type=file]" "/tmp/photo.png"');
  });

  it("escapes embedded quotes in user-supplied text", () => {
    expect(
      buildPickerActionLine("fill", fieldEmail, undefined, {
        text: 'a"b',
      }),
    ).toBe('fill field "Email" with "a\\"b"');
  });

  it("builds drag with toLocator", () => {
    expect(
      buildPickerActionLine("drag", testidSave, undefined, {
        toLocator: { kind: "testid", value: "drop" },
      }),
    ).toBe('drag testid "save" to testid "drop"');
  });

  it("preserves indent for input actions", () => {
    expect(
      buildPickerActionLine(
        "fill",
        fieldEmail,
        parseLine('    click field "Old"'),
        { text: "x" },
      ),
    ).toBe('    fill field "Email" with "x"');
  });

  it.each([
    ["fill", { value: "x" }, /fill action requires options.text/],
    ["type", {}, /type action requires options.text/],
    ["select", {}, /select action requires options.value/],
    ["upload", { text: "x" }, /upload action requires options.path/],
    ["drag", {}, /drag action requires options.toLocator/],
  ] as const)("throws when %s missing required option", (action, opts, re) => {
    expect(() =>
      buildPickerActionLine(action, fieldEmail, undefined, opts),
    ).toThrow(re);
  });
});

describe("getPickerActionItems", () => {
  const baseActions = ["click", "hover", "assert", "wait-for", "drag"];

  it("returns the four target-only verbs + drag when no metadata", () => {
    const items = getPickerActionItems().map((i) => i.action);
    expect(items).toEqual(baseActions);
  });

  it("promotes fill + type when element is a text input", () => {
    const meta: PickElementMeta = { isTextInput: true };
    const items = getPickerActionItems(meta).map((i) => i.action);
    expect(items.slice(0, 2)).toEqual(["fill", "type"]);
    // Always-on verbs still present after promotion.
    for (const v of baseActions) expect(items).toContain(v);
  });

  it("promotes select when element is a <select>", () => {
    const meta: PickElementMeta = { isSelect: true };
    expect(getPickerActionItems(meta)[0].action).toBe("select");
  });

  it("promotes upload when element is a file input", () => {
    const meta: PickElementMeta = { isFileInput: true };
    expect(getPickerActionItems(meta)[0].action).toBe("upload");
  });

  it("flags input-required actions on the items it returns", () => {
    const items = getPickerActionItems({ isTextInput: true });
    expect(items.find((i) => i.action === "fill")?.requiresInput).toBe(true);
    expect(items.find((i) => i.action === "click")?.requiresInput).toBe(false);
    expect(items.find((i) => i.action === "drag")?.requiresInput).toBe(true);
  });
});

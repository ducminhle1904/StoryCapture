import { describe, expect, it } from "vitest";

import type { PickElementMeta, PickLocator } from "@/ipc/picker";
import type { Command } from "@/ipc/parse";

import { parseLine } from "./picker-emit-rewrite";
import {
  buildPickerActionLine,
  escapeDslString,
  formatPickedTarget,
  getPickerActionItems,
  inferDefaultAction,
  validatePickerActionRoundTrip,
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
  it.each([
    ["button", "Save", '<button> "Save"'],
    ["textbox", "Search Wikipedia", '<textbox> "Search Wikipedia"'],
    ["searchbox", "Search", '<searchbox> "Search"'],
    ["spinbutton", "Quantity", '<spinbutton> "Quantity"'],
    ["textbox", 'Search "Wikipedia" \\ docs', '<textbox> "Search \\"Wikipedia\\" \\\\ docs"'],
  ])("formats role %s with canonical angle-bracket syntax", (role, name, expected) => {
    expect(
      formatPickedTarget({ kind: "role", value: { role, name } }),
    ).toBe(expected);
  });
  it("appends nth after a canonical role target", () => {
    expect(
      formatPickedTarget({
        kind: "role",
        value: { role: "textbox", name: "Search Wikipedia" },
        nth: 2,
      }),
    ).toBe('<textbox> "Search Wikipedia" nth 2');
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
  it("throws when a role is empty but allows an empty accessible name", () => {
    expect(() =>
      formatPickedTarget({ kind: "role", value: { role: "", name: "Name" } }),
    ).toThrow(/role locator/);
    expect(
      formatPickedTarget({ kind: "role", value: { role: "button", name: "" } }),
    ).toBe('<button> ""');
  });
});

describe("validatePickerActionRoundTrip", () => {
  const span = { start: 0, end: 1, line: 1, col: 1 };

  it("accepts canonical arbitrary roles and preserves input values", () => {
    expect(() =>
      validatePickerActionRoundTrip(
        "type",
        { kind: "role", value: { role: "textbox", name: "Search" } },
        { text: "ElectronJS" },
        {
          verb: "type",
          target: { kind: "role", value: { role: "textbox", name: "Search" } },
          text: "ElectronJS",
          span,
        },
      ),
    ).not.toThrow();
  });

  it("rejects a semantic target mismatch with a canonical role hint", () => {
    expect(() =>
      validatePickerActionRoundTrip(
        "click",
        { kind: "role", value: { role: "textbox", name: "Search" } },
        undefined,
        {
          verb: "click",
          target: { kind: "text", value: 'textbox "Search"' },
          span,
        },
      ),
    ).toThrow(/canonical <textbox>.*not inserted/);
  });

  it("does not reject a valid raw text target", () => {
    expect(() =>
      validatePickerActionRoundTrip(
        "click",
        { kind: "text", value: "Sign In" },
        undefined,
        {
          verb: "click",
          target: { kind: "text", value: "Sign In" },
          span,
        },
      ),
    ).not.toThrow();
  });

  it("preserves nth and validates both drag endpoints", () => {
    expect(() =>
      validatePickerActionRoundTrip(
        "drag",
        { kind: "testid", value: "source", nth: 2 },
        { toLocator: { kind: "testid", value: "destination", nth: 3 } },
        {
          verb: "drag",
          from: { kind: "test_id", value: "source" },
          from_nth: 2,
          to: { kind: "test_id", value: "destination" },
          to_nth: 3,
          span,
        },
      ),
    ).not.toThrow();
  });

  it("rejects changed values and malformed parser payloads", () => {
    expect(() =>
      validatePickerActionRoundTrip(
        "select",
        { kind: "label", value: "Country" },
        { value: "USA" },
        {
          verb: "select",
          target: { kind: "label", value: "Country" },
          value: "Canada",
          span,
        },
      ),
    ).toThrow(/value changed during parse-back/);

    expect(() =>
      validatePickerActionRoundTrip(
        "click",
        { kind: "text", value: "Sign In" },
        undefined,
        { verb: "click", target: null, span } as unknown as Command,
      ),
    ).toThrow(/invalid parsed shape.*not inserted/);
  });
});

describe("buildPickerActionLine", () => {
  it("builds click", () => {
    expect(buildPickerActionLine("click", roleSave)).toBe('click <button> "Save"');
  });
  it("builds hover", () => {
    expect(buildPickerActionLine("hover", roleSave)).toBe('hover <button> "Save"');
  });
  it("builds assert", () => {
    expect(buildPickerActionLine("assert", roleSave)).toBe(
      'assert <button> "Save"',
    );
  });
  it("builds wait-for with default 5s timeout", () => {
    expect(buildPickerActionLine("wait-for", roleSave)).toBe(
      'wait-for <button> "Save" timeout 5s',
    );
  });
  it("preserves indent from parsed line", () => {
    expect(
      buildPickerActionLine(
        "click",
        roleSave,
        parseLine('    hover field "Old"'),
      ),
    ).toBe('    click <button> "Save"');
  });
  it("preserves existing wait-for timeout when action is wait-for", () => {
    expect(
      buildPickerActionLine(
        "wait-for",
        roleSave,
        parseLine('    wait-for text "Old" timeout 10s'),
      ),
    ).toBe('    wait-for <button> "Save" timeout 10s');
  });
  it("falls back to default timeout when parsed line is not wait-for", () => {
    expect(
      buildPickerActionLine(
        "wait-for",
        roleSave,
        parseLine('    click text "Old"'),
      ),
    ).toBe('    wait-for <button> "Save" timeout 5s');
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

describe("buildPickerActionLine — nth postfix", () => {
  it("builds click+testid with nth=2", () => {
    expect(
      buildPickerActionLine("click", { kind: "testid", value: "row", nth: 2 }),
    ).toBe('click testid "row" nth 2');
  });

  it("builds click+role with nth=1", () => {
    expect(
      buildPickerActionLine("click", {
        kind: "role",
        value: { role: "button", name: "Save" },
        nth: 1,
      }),
    ).toBe('click <button> "Save" nth 1');
  });

  it("builds hover+label with nth=3", () => {
    expect(
      buildPickerActionLine("hover", { kind: "label", value: "Email", nth: 3 }),
    ).toBe('hover field "Email" nth 3');
  });

  it("builds wait-for+text_exact with nth=2 (nth before timeout)", () => {
    expect(
      buildPickerActionLine("wait-for", {
        kind: "text_exact",
        value: "Submit",
        nth: 2,
      }),
    ).toBe('wait-for text "Submit" nth 2 timeout 5s');
  });

  it("builds assert+testid with nth=1", () => {
    expect(
      buildPickerActionLine("assert", { kind: "testid", value: "row", nth: 1 }),
    ).toBe('assert testid "row" nth 1');
  });

  it("builds fill+testid with nth=1 + text option", () => {
    expect(
      buildPickerActionLine(
        "fill",
        { kind: "testid", value: "email", nth: 1 },
        undefined,
        { text: "alice@x" },
      ),
    ).toBe('fill testid "email" nth 1 with "alice@x"');
  });

  it("legacy locator without nth produces no postfix", () => {
    expect(buildPickerActionLine("click", { kind: "testid", value: "row" })).toBe(
      'click testid "row"',
    );
  });

  it("rejects nth < 1", () => {
    expect(() =>
      buildPickerActionLine("click", { kind: "testid", value: "row", nth: 0 }),
    ).toThrow(/positive integer/);
  });
});

describe("parsePickerLine — nth postfix", () => {
  it("extracts nth from a click+testid line", () => {
    const parsed = parseLine('click testid "row" nth 2');
    expect(parsed).toMatchObject({
      verb: "click",
      hasTargetShape: true,
      nth: 2,
      trailing: "",
    });
  });

  it("legacy line without nth → nth is undefined", () => {
    const parsed = parseLine('click testid "row"');
    expect(parsed.hasTargetShape).toBe(true);
    expect(parsed.nth).toBeUndefined();
  });

  it("extracts nth + preserves timeout from wait-for line", () => {
    const parsed = parseLine('wait-for field "Email" nth 3 timeout 5s');
    expect(parsed).toMatchObject({
      verb: "wait-for",
      hasTargetShape: true,
      nth: 3,
      trailing: "timeout 5s",
    });
  });

  it("round-trip: build({nth:2}) → parse → returns nth=2", () => {
    const built = buildPickerActionLine("click", {
      kind: "testid",
      value: "row",
      nth: 2,
    });
    const parsed = parseLine(built);
    expect(parsed.nth).toBe(2);
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

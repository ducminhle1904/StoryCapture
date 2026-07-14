import { describe, expect, it } from "vitest";
import { buildPickerActionLine } from "../../src/features/editor/picker-action-dsl";
import type { PickLocator } from "../../src/ipc/picker";
import { parsedCommands, parseStorySource } from "./story-parser";

function commandFor(line: string) {
  return parsedCommands(`story "Demo" {
scene "Main" {
  ${line}
}
}`)[0];
}

describe("story parser host command targets", () => {
  it.each([
    ["scroll down 300px", { direction: "down", amount: 300, unit: "px" }],
    ["scroll down 50vh", { direction: "down", amount: 50, unit: "vh" }],
    ["scroll left", { direction: "left", amount: 500, unit: "px" }],
    ["scroll up 12.5", { direction: "up", amount: 12.5, unit: "px" }],
  ])("parses canonical and legacy document scroll: %s", (line, expected) => {
    expect(commandFor(line)).toMatchObject({ verb: "scroll", ...expected });
  });

  it.each([
    [
      'scroll selector ".activity-panel" down 300px',
      { kind: "selector", value: ".activity-panel" },
      undefined,
    ],
    ['scroll testid "results" nth 2 up 50vh', { kind: "test_id", value: "results" }, 2],
  ])("parses targeted scroll: %s", (line, target, targetNth) => {
    expect(commandFor(line)).toMatchObject({
      verb: "scroll",
      target,
      target_nth: targetNth,
      amount: line.includes("50vh") ? 50 : 300,
      unit: line.includes("50vh") ? "vh" : "px",
    });
  });

  it.each([
    "scroll down 0px",
    "scroll down -1px",
    "scroll down Infinity",
    "scroll down 3em",
  ])("diagnoses invalid scroll amount: %s", (line) => {
    const result = parseStorySource(`story "Demo" {\nscene "Main" {\n${line}\n}\n}`);
    expect(result.ast?.scenes[0]?.commands).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("positive finite"),
      }),
    ]);
  });

  it.each([
    ['wait-for-visible <heading> "Login" timeout 5s', "wait-for-visible"],
    ['assert-visible testid "result"', "assert-visible"],
  ])("parses visible command %s", (line, verb) => {
    expect(commandFor(line)).toMatchObject({ verb, target: expect.any(Object) });
  });

  it("parses wait-for role targets with timeout modifiers", () => {
    expect(commandFor('wait-for heading "Login" timeout 15000ms')).toMatchObject({
      verb: "wait-for",
      target: { kind: "role", value: { role: "heading", name: "Login" } },
      timeout_ms: 15000,
    });
  });

  it.each([
    ['click <textbox> "Search Wikipedia"', "click"],
    ['hover <searchbox> "Search"', "hover"],
    ['wait-for <heading> "Main Page" timeout 5s', "wait-for"],
    ['assert <spinbutton> "Quantity"', "assert"],
    ['type <textbox> "Search Wikipedia" "ElectronJS"', "type"],
  ])("parses canonical role target for %s", (line, verb) => {
    expect(commandFor(line)).toMatchObject({
      verb,
      target: expect.objectContaining({ kind: "role" }),
    });
  });

  it("parses fill as the runtime type command without losing its value", () => {
    expect(commandFor('fill <textbox> "Search Wikipedia" with "ElectronJS"')).toMatchObject({
      verb: "type",
      target: {
        kind: "role",
        value: { role: "textbox", name: "Search Wikipedia" },
      },
      text: "ElectronJS",
    });
  });

  it("parses canonical drag targets and nth modifiers", () => {
    expect(commandFor('drag <row> "Source" nth 2 to <row> "Destination" nth 3')).toMatchObject({
      verb: "drag",
      from: { kind: "role", value: { role: "row", name: "Source" } },
      from_nth: 2,
      to: { kind: "role", value: { role: "row", name: "Destination" } },
      to_nth: 3,
    });
  });

  it.each(["click", "type"])("keeps legacy bare textbox working for %s", (verb) => {
    const suffix = verb === "type" ? ' "ElectronJS"' : "";
    expect(commandFor(`${verb} textbox "Search Wikipedia"${suffix}`)).toMatchObject({
      verb,
      target: {
        kind: "role",
        value: { role: "textbox", name: "Search Wikipedia" },
      },
      ...(verb === "type" ? { text: "ElectronJS" } : {}),
    });
  });

  it.each([
    ["button", "Save"],
    ["textbox", "Search Wikipedia"],
    ["searchbox", "Search"],
    ["spinbutton", "Quantity"],
    ["textbox", 'Search "Wikipedia" \\ docs'],
  ])("round-trips a Picker-generated %s locator", (role, name) => {
    const locator: PickLocator = { kind: "role", value: { role, name } };
    const line = buildPickerActionLine("type", locator, undefined, {
      text: "value",
    });

    expect(commandFor(line)).toMatchObject({
      verb: "type",
      target: { kind: "role", value: { role, name } },
      text: "value",
    });
  });

  it("parses value-bearing field targets without consuming the label as text", () => {
    expect(commandFor('type field "Email Address" "debug@example.com"')).toMatchObject({
      verb: "type",
      target: { kind: "label", value: "Email Address" },
      text: "debug@example.com",
    });
    expect(commandFor('type field "EMAIL ADDRESS" "debug"')).toMatchObject({
      verb: "type",
      target: { kind: "label", value: "EMAIL ADDRESS" },
      text: "debug",
    });
    expect(commandFor('type field "Email Address" with "debug@example.com"')).toMatchObject({
      verb: "type",
      target: { kind: "label", value: "Email Address" },
      text: "debug@example.com",
    });
  });

  it("parses role keyword, text target, target nth, and selectors with spaces", () => {
    expect(commandFor("click Sign In")).toMatchObject({
      verb: "click",
      target: { kind: "text", value: "Sign In" },
    });
    expect(commandFor('click button "Sign In"')).toMatchObject({
      verb: "click",
      target: { kind: "role", value: { role: "button", name: "Sign In" } },
    });
    expect(commandFor('wait-for text "Total Bots" timeout 15000ms')).toMatchObject({
      verb: "wait-for",
      target: { kind: "text", value: "Total Bots" },
      timeout_ms: 15000,
    });
    expect(commandFor('click button "Save" nth 2')).toMatchObject({
      verb: "click",
      target: { kind: "role", value: { role: "button", name: "Save" } },
      target_nth: 2,
    });
    expect(
      commandFor(
        'assert selector "div:nth-of-type(12) > .group > .flex > div > .text-muted-foreground"',
      ),
    ).toMatchObject({
      verb: "assert",
      target: {
        kind: "selector",
        value: "div:nth-of-type(12) > .group > .flex > div > .text-muted-foreground",
      },
    });
  });

  it("keeps existing target forms working", () => {
    expect(commandFor('click selector "#submit"')).toMatchObject({
      target: { kind: "selector", value: "#submit" },
    });
    expect(commandFor('click testid "submit-button"')).toMatchObject({
      target: { kind: "test_id", value: "submit-button" },
    });
    expect(commandFor('click aria "Close dialog"')).toMatchObject({
      target: { kind: "aria", value: "Close dialog" },
    });
    expect(commandFor('wait-for <heading> "Login" timeout 5s')).toMatchObject({
      target: { kind: "role", value: { role: "heading", name: "Login" } },
      timeout_ms: 5000,
    });
    expect(commandFor('wait-for "Loaded" timeout 5s')).toMatchObject({
      target: { kind: "text_exact", value: "Loaded" },
      timeout_ms: 5000,
    });
  });

  it("parses text overlays with default and explicit durations", () => {
    expect(commandFor('text-overlay "Welcome"')).toMatchObject({
      verb: "text-overlay",
      text: "Welcome",
      duration_ms: 2_000,
    });
    expect(commandFor('text-overlay "Longer caption" 5000ms')).toMatchObject({
      verb: "text-overlay",
      text: "Longer caption",
      duration_ms: 5_000,
    });
    expect(commandFor('text-overlay "Say \\"hello\\"" 100ms')).toMatchObject({
      text: 'Say "hello"',
      duration_ms: 100,
    });
    expect(commandFor('text-overlay "Longest" 30000ms')).toMatchObject({
      duration_ms: 30_000,
    });
  });

  it("preserves text overlay step metadata", () => {
    const stepId = "12345678-1234-1234-1234-123456789abc";
    expect(commandFor(`text-overlay "Welcome" 2000ms  # @id=${stepId}`)).toMatchObject({
      verb: "text-overlay",
      step_id: stepId,
    });
  });

  it.each([
    "text-overlay",
    'text-overlay ""',
    'text-overlay "   " 2000ms',
    'text-overlay "Title" 5s',
    'text-overlay "Title" 5000',
    'text-overlay "Title" 5.5ms',
    'text-overlay "Title" -100ms',
    'text-overlay "Title" 0ms',
    'text-overlay "Title" 99ms',
    'text-overlay "Title" 30001ms',
    'text-overlay "Title" 5000ms trailing',
    "text-overlay Title 2000ms",
  ])("diagnoses invalid text overlay syntax: %s", (line) => {
    const result = parseStorySource(`story "Demo" {\nscene "Main" {\n${line}\n}\n}`);
    expect(result.ast?.scenes[0]?.commands).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("Text overlay"),
      }),
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { parsedCommands } from "./story-parser";

function commandFor(line: string) {
  return parsedCommands(`story "Demo" {
scene "Main" {
  ${line}
}
}`)[0];
}

describe("story parser host command targets", () => {
  it("parses wait-for role targets with timeout modifiers", () => {
    expect(commandFor('wait-for heading "Login" timeout 15000ms')).toMatchObject({
      verb: "wait-for",
      target: { kind: "role", value: { role: "heading", name: "Login" } },
      timeout_ms: 15000,
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
});

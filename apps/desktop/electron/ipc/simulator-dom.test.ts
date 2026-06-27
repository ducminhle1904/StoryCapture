import { afterEach, describe, expect, it } from "vitest";

import {
  findSimulatorTarget,
  setActiveElementValueScript,
  setSimulatorTargetValueIncrementalScript,
  setSimulatorTargetValueScript,
  simulatorTargetCenterScript,
  simulatorTargetGeometryScript,
} from "./simulator-dom";

function makeVisible(el: Element): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        bottom: 20,
        height: 20,
        left: 0,
        right: 200,
        top: 0,
        width: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

describe("simulator DOM helpers", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("matches field labels case-insensitively and prefers editable controls", () => {
    document.body.innerHTML = `
      <label for="email">Email Address</label>
      <div>Email Address</div>
      <input id="email" type="email" />
    `;
    document.querySelectorAll("*").forEach(makeVisible);

    const target = findSimulatorTarget({ kind: "label", value: "EMAIL ADDRESS" });

    expect(target).toBe(document.getElementById("email"));
  });

  it("builds a center script that can resolve the editable label target", () => {
    document.body.innerHTML = `
      <label for="email">Email Address</label>
      <input id="email" type="email" />
    `;
    document.querySelectorAll("*").forEach(makeVisible);

    const center = window.eval(simulatorTargetCenterScript({ kind: "label", value: "EMAIL ADDRESS" }));

    expect(center).toEqual({ x: 100, y: 10 });
  });

  it("builds a geometry script with label, center, and bounds", () => {
    document.body.innerHTML = `
      <button aria-label="Save draft">Save</button>
    `;
    const button = document.querySelector("button");
    if (!button) throw new Error("button fixture missing");
    Object.defineProperty(button, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          bottom: 90,
          height: 40,
          left: 120,
          right: 320,
          top: 50,
          width: 200,
          x: 120,
          y: 50,
          toJSON: () => ({}),
        }) as DOMRect,
    });

    const target = window.eval(
      simulatorTargetGeometryScript(
        { kind: "role", value: { role: "button", name: "Save draft" } },
        undefined,
        null,
      ),
    );

    expect(target).toEqual({
      kind: "element",
      label: "Save draft",
      center: { x: 220, y: 70 },
      bounds: { x: 120, y: 50, w: 200, h: 40 },
    });
  });

  it("builds a value script that writes full text into the active input and emits events", () => {
    document.body.innerHTML = `<input id="email" type="email" />`;
    const input = document.getElementById("email") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    input.focus();
    const didWrite = window.eval(setActiveElementValueScript("debug"));

    expect(didWrite).toBe(true);
    expect(input.value).toBe("debug");
    expect(events).toEqual(["input", "change"]);
  });

  it("builds a target value script that writes to a resolved label target and emits events", () => {
    document.body.innerHTML = `
      <label for="email">Email Address</label>
      <input id="email" type="email" />
    `;
    document.querySelectorAll("*").forEach(makeVisible);
    const input = document.getElementById("email") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    const didWrite = window.eval(
      setSimulatorTargetValueScript({ kind: "label", value: "EMAIL ADDRESS" }, "debug"),
    );

    expect(didWrite).toBe(true);
    expect(input.value).toBe("debug");
    expect(events).toEqual(["input", "change"]);
  });

  it("builds an incremental value script that emits input per typed character", async () => {
    document.body.innerHTML = `
      <label for="email">Email Address</label>
      <input id="email" type="email" value="old" />
    `;
    document.querySelectorAll("*").forEach(makeVisible);
    const input = document.getElementById("email") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push(`input:${input.value}`));
    input.addEventListener("change", () => events.push(`change:${input.value}`));

    const didWrite = await window.eval(
      setSimulatorTargetValueIncrementalScript(
        { kind: "label", value: "EMAIL ADDRESS" },
        "abc",
        undefined,
        null,
        0,
      ),
    );

    expect(didWrite).toBe(true);
    expect(input.value).toBe("abc");
    expect(events).toEqual(["input:", "input:a", "input:ab", "input:abc", "change:abc"]);
  });

  it("caps incremental typing for long values", async () => {
    document.body.innerHTML = `<textarea id="notes"></textarea>`;
    document.querySelectorAll("*").forEach(makeVisible);
    const textarea = document.getElementById("notes") as HTMLTextAreaElement;
    const events: string[] = [];
    const value = "x".repeat(201);
    textarea.addEventListener("input", () => events.push(`input:${textarea.value.length}`));
    textarea.addEventListener("change", () => events.push(`change:${textarea.value.length}`));

    const didWrite = await window.eval(
      setSimulatorTargetValueIncrementalScript(
        { kind: "selector", value: "#notes" },
        value,
        undefined,
        "#notes",
        0,
      ),
    );

    expect(didWrite).toBe(true);
    expect(textarea.value).toBe(value);
    expect(events).toEqual(["input:201", "change:201"]);
  });

  it("does not report success when the resolved target is not editable", () => {
    document.body.innerHTML = `<div>Email Address</div>`;
    document.querySelectorAll("*").forEach(makeVisible);

    const didWrite = window.eval(
      setSimulatorTargetValueScript({ kind: "text", value: "Email Address" }, "debug"),
    );

    expect(didWrite).toBe(false);
  });

  it("falls back to a focused child input for role wrapper targets", () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="Country">
        <input id="country" />
      </div>
    `;
    document.querySelectorAll("*").forEach(makeVisible);
    const input = document.getElementById("country") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    input.focus();

    const didWrite = window.eval(
      setSimulatorTargetValueScript(
        { kind: "role", value: { role: "combobox", name: "Country" } },
        "France",
      ),
    );

    expect(didWrite).toBe(true);
    expect(input.value).toBe("France");
    expect(events).toEqual(["input", "change"]);
  });
});

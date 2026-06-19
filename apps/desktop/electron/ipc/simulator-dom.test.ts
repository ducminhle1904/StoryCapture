import { afterEach, describe, expect, it } from "vitest";

import {
  findSimulatorTarget,
  setActiveElementValueScript,
  setSimulatorTargetValueScript,
  simulatorTargetCenterScript,
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

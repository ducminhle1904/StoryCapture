import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { observeTargetVisibility, TARGET_SAFE_INSET_PX } from "./target-visibility";

function setRect(
  el: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      bottom: rect.top + rect.height,
      right: rect.left + rect.width,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

function setDimension(el: Element, key: string, value: number): void {
  Object.defineProperty(el, key, { configurable: true, value });
}

describe("target visibility", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("uses a 24px safe viewport and rejects outside or one-pixel intersections", () => {
    const target = document.createElement("button");
    document.body.append(target);

    setRect(target, { left: 100, top: 700, width: 100, height: 40 });
    expect(observeTargetVisibility(target, true)).toMatchObject({
      status: "not_ready",
      reason: "outside_viewport",
      diagnostics: { safeViewportBounds: { x: 24, y: 24, w: 752, h: 552 } },
    });

    setRect(target, { left: 100, top: 599, width: 100, height: 40 });
    expect(observeTargetVisibility(target, true)).toMatchObject({
      status: "not_ready",
      reason: "outside_viewport",
    });
    expect(TARGET_SAFE_INSET_PX).toBe(24);
  });

  it("accepts the nearest legal safe region at the bottom boundary", () => {
    const target = document.createElement("button");
    document.body.append(target);
    setRect(target, { left: 100, top: 550, width: 200, height: 100 });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [target],
    });

    expect(observeTargetVisibility(target, true)).toMatchObject({
      status: "ready",
      diagnostics: {
        clippedBounds: { x: 100, y: 550, w: 200, h: 26 },
        selectedPoint: { x: 200, y: 563 },
      },
    });
  });

  it("selects a safe point for a target larger than the viewport", () => {
    const target = document.createElement("div");
    document.body.append(target);
    setRect(target, { left: -100, top: -100, width: 1_000, height: 800 });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [target],
    });

    const observation = observeTargetVisibility(target, false);

    expect(observation).toMatchObject({
      status: "ready",
      diagnostics: {
        clippedBounds: { x: 24, y: 24, w: 752, h: 552 },
        selectedPoint: { x: 400, y: 300 },
      },
    });
  });

  it("accepts an alternate candidate when the center is covered", () => {
    const target = document.createElement("button");
    const cover = document.createElement("div");
    cover.id = "sticky-header";
    document.body.append(target, cover);
    setRect(target, { left: 100, top: 100, width: 200, height: 100 });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (x: number, y: number) => (x === 200 && y === 150 ? [cover, target] : [target]),
    });

    const observation = observeTargetVisibility(target, true);

    expect(observation).toMatchObject({
      status: "ready",
      diagnostics: {
        selectedPoint: { x: 200, y: 101 },
        candidates: [
          { x: 200, y: 150, coveredBy: { tag: "div", id: "sticky-header" } },
          { x: 200, y: 101, coveredBy: null },
        ],
      },
    });
  });

  it("reports the covering element when every candidate is blocked", () => {
    const target = document.createElement("button");
    const cover = document.createElement("div");
    cover.setAttribute("role", "dialog");
    cover.setAttribute("data-testid", "consent");
    document.body.append(target, cover);
    setRect(target, { left: 100, top: 100, width: 200, height: 100 });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [cover, target],
    });

    expect(observeTargetVisibility(target, true)).toMatchObject({
      status: "not_ready",
      reason: "covered",
      diagnostics: {
        cover: { tag: "div", role: "dialog", testId: "consent" },
        candidates: expect.arrayContaining([
          expect.objectContaining({ coveredBy: expect.objectContaining({ tag: "div" }) }),
        ]),
      },
    });
  });

  it("detects nested scrollable ancestors and clips to their safe bounds", () => {
    const scroller = document.createElement("div");
    const target = document.createElement("button");
    scroller.style.overflowY = "auto";
    scroller.append(target);
    document.body.append(scroller);
    setRect(scroller, { left: 50, top: 50, width: 300, height: 200 });
    setRect(target, { left: 60, top: 60, width: 280, height: 180 });
    setDimension(scroller, "clientWidth", 300);
    setDimension(scroller, "clientHeight", 200);
    setDimension(scroller, "scrollWidth", 300);
    setDimension(scroller, "scrollHeight", 800);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [target],
    });

    const observation = observeTargetVisibility(target, true);

    expect(observation).toMatchObject({
      status: "ready",
      diagnostics: {
        clippedBounds: { x: 74, y: 74, w: 252, h: 152 },
        scrollers: [
          expect.objectContaining({
            kind: "element",
            bounds: { x: 50, y: 50, w: 300, h: 200 },
            maxScroll: { x: 0, y: 600 },
          }),
          expect.objectContaining({ kind: "document" }),
        ],
      },
    });
  });

  it("returns typed reasons for detached, hidden, disabled, and invalid targets", () => {
    const detached = document.createElement("button");
    expect(observeTargetVisibility(detached, true)).toMatchObject({ reason: "detached" });

    const hidden = document.createElement("button");
    hidden.style.display = "none";
    document.body.append(hidden);
    expect(observeTargetVisibility(hidden, true)).toMatchObject({ reason: "hidden" });

    const disabled = document.createElement("button");
    disabled.disabled = true;
    document.body.append(disabled);
    expect(observeTargetVisibility(disabled, true)).toMatchObject({ reason: "disabled" });

    const invalid = document.createElement("button");
    document.body.append(invalid);
    setRect(invalid, { left: 0, top: 0, width: Number.NaN, height: 20 });
    expect(observeTargetVisibility(invalid, true)).toMatchObject({ reason: "invalid_bounds" });
  });
});

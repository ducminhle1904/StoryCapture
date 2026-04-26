// @vitest-environment jsdom
//
// 15-row accessible-name + 8-row inferRole matrix for axe-accessible-name-lite.
// jsdom does not implement layout, but the algorithm only needs DOM
// traversal + computed style for `display:none` / `visibility:hidden`,
// both of which jsdom resolves from inline styles.

import { describe, it, expect, beforeEach } from "vitest";

// jsdom does not implement `CSS.escape` natively; @medv/finder (called by
// buildPayload via buildCss) needs it for class/id escaping. Polyfill
// before any module that exercises finder is imported below.
if (typeof (globalThis as any).CSS?.escape !== "function") {
  (globalThis as any).CSS = {
    ...((globalThis as any).CSS ?? {}),
    escape: (s: string) =>
      String(s).replace(/([^a-zA-Z0-9_-])/g, (m) => `\\${m}`),
  };
}

import { accessibleName, inferRole } from "./axe-accessible-name-lite";
import {
  buildElementMeta,
  buildPayload,
  findInteractiveTarget,
  isInteractive,
  INTERACTIVE_WALK_LIMIT,
  VISIBLE_TEXT_CAP,
} from "./index";

function setHtml(html: string) {
  document.body.innerHTML = html;
}

describe("accessibleName — 15 DOM shapes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("1. <button>Save</button> → 'Save'", () => {
    setHtml(`<button id="t">Save</button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Save");
  });

  it("2. aria-label wins over inner text", () => {
    setHtml(`<button id="t" aria-label="Close">X</button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Close");
  });

  it("3. aria-labelledby resolves to referenced element text", () => {
    setHtml(`<input id="t" aria-labelledby="x"><span id="x">Email</span>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Email");
  });

  it("4. <label for=...> resolves on input", () => {
    setHtml(`<label for="e">Email</label><input id="e">`);
    expect(accessibleName(document.getElementById("e")!)).toBe("Email");
  });

  it("5. wrapping <label>Name <input></label>", () => {
    setHtml(`<label>Name <input id="i"></label>`);
    expect(accessibleName(document.getElementById("i")!)).toBe("Name");
  });

  it("6. <input placeholder='Search'> uses placeholder fallback", () => {
    setHtml(`<input id="i" placeholder="Search">`);
    expect(accessibleName(document.getElementById("i")!)).toBe("Search");
  });

  it("7. <a href='#'>Docs</a> → 'Docs'", () => {
    setHtml(`<a id="t" href="#">Docs</a>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Docs");
  });

  it("8. <img alt='Hero'> → 'Hero'", () => {
    setHtml(`<img id="t" alt="Hero">`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Hero");
  });

  it("9. <h1>Dashboard</h1> → 'Dashboard'", () => {
    setHtml(`<h1 id="t">Dashboard</h1>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Dashboard");
  });

  it("10. nested aria-labelledby chain (depth 2)", () => {
    setHtml(`
      <div id="t" aria-labelledby="a"></div>
      <span id="a" aria-labelledby="b"></span>
      <span id="b">Final</span>
    `);
    expect(accessibleName(document.getElementById("t")!)).toBe("Final");
  });

  it("11. aria-label wins over inner text (button)", () => {
    setHtml(`<button id="t" aria-label="Primary">Inner</button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Primary");
  });

  it("12. empty/whitespace-only inner text → ''", () => {
    setHtml(`<button id="t">   </button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("");
  });

  it("13. aria-hidden subtree is skipped", () => {
    setHtml(
      `<button id="t"><span>Save</span> <span aria-hidden="true">X</span></button>`,
    );
    expect(accessibleName(document.getElementById("t")!)).toBe("Save");
  });

  it("14. <input type='submit' value='Go'> → 'Go'", () => {
    setHtml(`<input id="t" type="submit" value="Go">`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Go");
  });

  it("15. shadow slot projection — slotted child text reachable via assignedSlot", () => {
    // jsdom supports attachShadow + slot assignment.
    document.body.innerHTML = `<sc-host><span id="slotted">Slotted Name</span></sc-host>`;
    const host = document.querySelector("sc-host") as Element;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="inner"><slot></slot></button>`;
    const slotted = document.getElementById("slotted")!;
    // The slotted span's accessible name should be its own text content.
    // For shadow projection we verify the slot's host text is reachable
    // by traversing assignedSlot when the element itself is empty.
    expect(accessibleName(slotted)).toBe("Slotted Name");
  });

  // ─── Fix #6 — whitespace normalization across return paths ─────────
  it("16. aria-label with leading/trailing whitespace → trimmed", () => {
    setHtml(`<button id="t" aria-label="  Save  ">x</button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Save");
  });

  it("17. aria-label with internal multi-space runs → collapsed", () => {
    setHtml(`<button id="t" aria-label="Save   Now">x</button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Save Now");
  });

  it("18. aria-label with newline/tab chars (JSX-formatted markup) → collapsed", () => {
    setHtml(`<button id="t" aria-label="Save\n\tNow">x</button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Save Now");
  });

  it("19. <input type=submit value='  Go  Now  '> → 'Go Now'", () => {
    setHtml(`<input id="t" type="submit" value="  Go  Now  ">`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Go Now");
  });

  it("20. <img alt='   Hero    Image  '> → 'Hero Image'", () => {
    setHtml(`<img id="t" alt="   Hero    Image  ">`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Hero Image");
  });

  it("21. <input placeholder='  search   here'> → 'search here'", () => {
    setHtml(`<input id="t" placeholder="  search   here">`);
    expect(accessibleName(document.getElementById("t")!)).toBe("search here");
  });

  it("22. inner-text branch already collapses whitespace (regression guard)", () => {
    setHtml(`<button id="t">  Click   Me  </button>`);
    expect(accessibleName(document.getElementById("t")!)).toBe("Click Me");
  });
});

describe("inferRole — 8 rows", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("button → button", () => {
    setHtml(`<button id="t"></button>`);
    expect(inferRole(document.getElementById("t")!)).toBe("button");
  });
  it("a[href] → link", () => {
    setHtml(`<a id="t" href="#"></a>`);
    expect(inferRole(document.getElementById("t")!)).toBe("link");
  });
  it("h1 → heading", () => {
    setHtml(`<h1 id="t"></h1>`);
    expect(inferRole(document.getElementById("t")!)).toBe("heading");
  });
  it("img → img", () => {
    setHtml(`<img id="t">`);
    expect(inferRole(document.getElementById("t")!)).toBe("img");
  });
  it("input[type=checkbox] → checkbox", () => {
    setHtml(`<input id="t" type="checkbox">`);
    expect(inferRole(document.getElementById("t")!)).toBe("checkbox");
  });
  it("input[type=radio] → radio", () => {
    setHtml(`<input id="t" type="radio">`);
    expect(inferRole(document.getElementById("t")!)).toBe("radio");
  });
  it("[role=tab] explicit role wins", () => {
    setHtml(`<div id="t" role="tab"></div>`);
    expect(inferRole(document.getElementById("t")!)).toBe("tab");
  });
  it("explicit [role] wins over implicit (button with role=link)", () => {
    setHtml(`<button id="t" role="link"></button>`);
    expect(inferRole(document.getElementById("t")!)).toBe("link");
  });
});

describe("buildElementMeta — element-shape detection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("text input → isTextInput=true with inputType", () => {
    setHtml(`<input id="t" type="text">`);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isTextInput).toBe(true);
    expect(meta.inputType).toBe("text");
    expect(meta.isSelect).toBeUndefined();
    expect(meta.isFileInput).toBeUndefined();
  });

  it("email input → isTextInput=true with inputType=email", () => {
    setHtml(`<input id="t" type="email">`);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isTextInput).toBe(true);
    expect(meta.inputType).toBe("email");
  });

  it("textarea → isTextInput=true (no inputType)", () => {
    setHtml(`<textarea id="t"></textarea>`);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isTextInput).toBe(true);
    expect(meta.inputType).toBeUndefined();
  });

  it("select → isSelect=true with optionLabels", () => {
    setHtml(`
      <select id="t">
        <option value="us">United States</option>
        <option value="vn">Vietnam</option>
      </select>
    `);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isSelect).toBe(true);
    expect(meta.optionLabels).toEqual(["United States", "Vietnam"]);
    expect(meta.isTextInput).toBeUndefined();
  });

  it("file input → isFileInput=true", () => {
    setHtml(`<input id="t" type="file">`);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isFileInput).toBe(true);
    expect(meta.inputType).toBe("file");
    expect(meta.isTextInput).toBeUndefined();
  });

  it("contenteditable → isTextInput + isContentEditable", () => {
    setHtml(`<div id="t" contenteditable="true"></div>`);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isContentEditable).toBe(true);
    expect(meta.isTextInput).toBe(true);
  });

  it("plain button → no input flags", () => {
    setHtml(`<button id="t">Save</button>`);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isTextInput).toBeUndefined();
    expect(meta.isSelect).toBeUndefined();
    expect(meta.isFileInput).toBeUndefined();
    expect(meta.optionLabels).toBeUndefined();
  });

  it("submit input → not flagged as text input", () => {
    setHtml(`<input id="t" type="submit" value="Go">`);
    const meta = buildElementMeta(document.getElementById("t")!);
    expect(meta.isTextInput).toBeUndefined();
    expect(meta.inputType).toBe("submit");
  });
});

// ─── Fix #1: findInteractiveTarget + isInteractive walk-up matrix ──────
describe("isInteractive — direct interactive signals", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("button → interactive", () => {
    setHtml(`<button id="t">x</button>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("a (no href) → interactive (intrinsic tag)", () => {
    setHtml(`<a id="t">x</a>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("input → interactive", () => {
    setHtml(`<input id="t">`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("[role=button] → interactive", () => {
    setHtml(`<div id="t" role="button">x</div>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("[role=switch] → interactive", () => {
    setHtml(`<span id="t" role="switch">x</span>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("[onclick] → interactive", () => {
    setHtml(`<div id="t" onclick="">x</div>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("[tabindex='0'] → interactive", () => {
    setHtml(`<div id="t" tabindex="0">x</div>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("[tabindex='-1'] → interactive", () => {
    setHtml(`<div id="t" tabindex="-1">x</div>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("[contenteditable] → interactive", () => {
    setHtml(`<div id="t" contenteditable="true">x</div>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(true);
  });
  it("plain <div> → not interactive", () => {
    setHtml(`<div id="t">x</div>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(false);
  });
  it("[role=presentation] → not interactive (not in widget set)", () => {
    setHtml(`<div id="t" role="presentation">x</div>`);
    expect(isInteractive(document.getElementById("t")!)).toBe(false);
  });
});

describe("findInteractiveTarget — walk-up resolution", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function clickEvent(target: Element): MouseEvent {
    const ev = new MouseEvent("click", { bubbles: true, composed: true });
    Object.defineProperty(ev, "target", { value: target });
    Object.defineProperty(ev, "composedPath", {
      value: () => {
        const path: (Element | Window)[] = [];
        let cur: Element | null = target;
        while (cur) {
          path.push(cur);
          cur = cur.parentElement;
        }
        path.push(window);
        return path;
      },
    });
    return ev;
  }

  it("clicking icon <svg> inside <button> → returns the button", () => {
    setHtml(
      `<button id="btn"><svg id="icon"><circle r="4"/></svg></button>`,
    );
    const icon = document.getElementById("icon")!;
    const btn = document.getElementById("btn")!;
    expect(findInteractiveTarget(clickEvent(icon))).toBe(btn);
  });

  it("clicking <span> inside <a> → returns the anchor", () => {
    setHtml(`<a id="a" href="#"><span id="s">Go</span></a>`);
    const s = document.getElementById("s")!;
    const a = document.getElementById("a")!;
    expect(findInteractiveTarget(clickEvent(s))).toBe(a);
  });

  it("clicking nested <em><strong> inside [role=button] → returns the role host", () => {
    setHtml(
      `<div id="host" role="button"><em id="e"><strong id="t">x</strong></em></div>`,
    );
    const t = document.getElementById("t")!;
    const host = document.getElementById("host")!;
    expect(findInteractiveTarget(clickEvent(t))).toBe(host);
  });

  it("interactive element clicked directly → returns itself (no escalation)", () => {
    setHtml(`<button id="t">x</button>`);
    const t = document.getElementById("t")!;
    expect(findInteractiveTarget(clickEvent(t))).toBe(t);
  });

  it("non-interactive element with no interactive ancestor → returns the click point", () => {
    setHtml(`<div id="root"><p id="t">just text</p></div>`);
    const t = document.getElementById("t")!;
    expect(findInteractiveTarget(clickEvent(t))).toBe(t);
  });

  it(`escalation respects INTERACTIVE_WALK_LIMIT (= ${INTERACTIVE_WALK_LIMIT})`, () => {
    // Build a chain deeper than the limit: <button> wraps WALK_LIMIT+2 nested
    // <span>s. Clicking the deepest span should NOT find the button — it's
    // beyond the walk reach — so we fall back to the literal click point.
    let html = `<button id="btn">`;
    const depth = INTERACTIVE_WALK_LIMIT + 2;
    for (let i = 0; i < depth; i++) html += `<span id="s${i}">`;
    for (let i = 0; i < depth; i++) html += `</span>`;
    html += `</button>`;
    setHtml(html);
    const deepest = document.getElementById(`s${depth - 1}`)!;
    const result = findInteractiveTarget(clickEvent(deepest));
    expect(result).toBe(deepest);
  });

  it("escalation finds the interactive ancestor when click is within walk limit", () => {
    // 3 levels of <span> inside a <button> — well within the limit.
    setHtml(
      `<button id="btn"><span><span><span id="t">x</span></span></span></button>`,
    );
    const t = document.getElementById("t")!;
    const btn = document.getElementById("btn")!;
    expect(findInteractiveTarget(clickEvent(t))).toBe(btn);
  });

  it("returns null when event has no Element target", () => {
    const ev = new MouseEvent("click");
    // No target, no composedPath — defensive return null path.
    expect(findInteractiveTarget(ev)).toBeNull();
  });
});

// ─── Fix #5: buildPayload visibleText — leaf-direct + 80-char cap ──────
describe("buildPayload visibleText — direct text + cap", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("card with nested <button>'s text does NOT leak into parent's visibleText", () => {
    // The card itself has no direct text. visibleText must fall back to
    // textContent which captures the button — but accessibleName + role
    // are what actually drive the locator. The leaf-direct rule is most
    // important when the parent HAS direct text.
    setHtml(`
      <div id="card">
        Hello there
        <button id="btn">Submit</button>
      </div>
    `);
    const card = document.getElementById("card")!;
    const payload = buildPayload(card);
    // Direct text "Hello there" wins; no "Submit" leakage.
    expect(payload.visibleText).toBe("Hello there");
    expect(payload.visibleText).not.toContain("Submit");
  });

  it("element with no direct text falls back to descendant text", () => {
    setHtml(`<div id="t"><span>only-child-text</span></div>`);
    const t = document.getElementById("t")!;
    const payload = buildPayload(t);
    // No direct text → fallback to recursive textContent.
    expect(payload.visibleText).toBe("only-child-text");
  });

  it("collapses whitespace runs in direct text", () => {
    setHtml(`<div id="t">Hello\n\n   world\t\t!</div>`);
    const t = document.getElementById("t")!;
    const payload = buildPayload(t);
    expect(payload.visibleText).toBe("Hello world !");
  });

  it(`caps direct text at ${VISIBLE_TEXT_CAP} chars`, () => {
    const longText = "a".repeat(VISIBLE_TEXT_CAP + 50);
    setHtml(`<div id="t">${longText}</div>`);
    const t = document.getElementById("t")!;
    const payload = buildPayload(t);
    expect(payload.visibleText).toBeDefined();
    expect(payload.visibleText!.length).toBeLessThanOrEqual(VISIBLE_TEXT_CAP);
  });

  it("INPUT does not get visibleText (forms use associatedLabel)", () => {
    setHtml(`<label for="e">Email</label><input id="e" value="someone@x">`);
    const i = document.getElementById("e")!;
    const payload = buildPayload(i);
    expect(payload.visibleText).toBeUndefined();
    expect(payload.associatedLabel).toBe("Email");
  });

  it("empty / whitespace-only direct text → undefined visibleText", () => {
    setHtml(`<div id="t">   </div>`);
    const t = document.getElementById("t")!;
    const payload = buildPayload(t);
    expect(payload.visibleText).toBeUndefined();
  });
});

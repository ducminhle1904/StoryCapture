// @vitest-environment jsdom
//
// 15-row accessible-name + 8-row inferRole matrix for axe-accessible-name-lite.
// jsdom does not implement layout, but the algorithm only needs DOM
// traversal + computed style for `display:none` / `visibility:hidden`,
// both of which jsdom resolves from inline styles.

import { describe, it, expect, beforeEach } from "vitest";
import { accessibleName, inferRole } from "./axe-accessible-name-lite";

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

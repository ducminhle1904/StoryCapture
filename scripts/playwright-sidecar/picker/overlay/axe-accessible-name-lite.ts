// Subset of the axe-core / WAI-ARIA accessible-name algorithm covering ONLY
// the 15 DOM shapes exercised by `index.test.ts`. NOT a full port — keep this
// file tiny so the overlay IIFE stays under ~10 KB after esbuild.
//
// Algorithms (in order of evaluation per WCAG 4.1.2 / ARIA 1.2 §4.3.2):
//   1. aria-labelledby chain (bounded depth 3)
//   2. aria-label
//   3. host-language label (label[for], wrapping <label>, value/alt/placeholder)
//   4. inner text content (skipping aria-hidden + display:none subtrees)
//   5. shadow slot projection via assignedSlot
//
// `inferRole` resolves the implicit ARIA role from tag + type, with the
// explicit `[role]` attribute always winning.

const MAX_LABELLEDBY_DEPTH = 3;

const ROLE_BY_TAG: Record<string, string> = {
  A: "link", // requires href; handled below
  BUTTON: "button",
  IMG: "img",
  H1: "heading",
  H2: "heading",
  H3: "heading",
  H4: "heading",
  H5: "heading",
  H6: "heading",
  SELECT: "combobox",
  // INPUT handled below (depends on type)
};

const INPUT_TYPE_ROLE: Record<string, string> = {
  text: "textbox",
  email: "textbox",
  password: "textbox",
  search: "textbox",
  tel: "textbox",
  url: "textbox",
  checkbox: "checkbox",
  radio: "radio",
  submit: "button",
  button: "button",
  reset: "button",
};

export function inferRole(el: Element): string | undefined {
  // Explicit [role] always wins.
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toUpperCase();
  if (tag === "A") {
    return el.hasAttribute("href") ? "link" : undefined;
  }
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return INPUT_TYPE_ROLE[type];
  }
  return ROLE_BY_TAG[tag];
}

function isHidden(el: Element): boolean {
  if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
  // jsdom doesn't compute layout, so getComputedStyle returns inline styles.
  // For matrix testing this is sufficient — production overlay runs in real
  // Chromium where getComputedStyle reflects the cascade.
  const view = (el.ownerDocument as Document).defaultView;
  if (view) {
    const style = view.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return true;
  }
  return false;
}

function getInnerText(el: Element): string {
  // Walk children, skip aria-hidden + display:none subtrees, accumulate text.
  let out = "";
  const childNodes = Array.from(el.childNodes);
  for (const node of childNodes) {
    if (node.nodeType === 3 /* Text */) {
      out += node.textContent || "";
    } else if (node.nodeType === 1 /* Element */) {
      const child = node as Element;
      if (isHidden(child)) continue;
      out += getInnerText(child);
    }
  }
  return out;
}

function resolveLabelledBy(doc: Document, ids: string, depth: number): string {
  if (depth >= MAX_LABELLEDBY_DEPTH) return "";
  const parts: string[] = [];
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    const ref = doc.getElementById(id);
    if (!ref) continue;
    // Recurse: aria-labelledby on the referenced element wins again.
    const nested = ref.getAttribute("aria-labelledby");
    if (nested) {
      const inner = resolveLabelledBy(doc, nested, depth + 1);
      if (inner) {
        parts.push(inner);
        continue;
      }
    }
    const ariaLabel = ref.getAttribute("aria-label");
    if (ariaLabel) {
      parts.push(ariaLabel);
      continue;
    }
    parts.push(getInnerText(ref).trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function findAssociatedLabel(el: Element): string | undefined {
  const id = el.getAttribute("id");
  const doc = el.ownerDocument as Document;
  if (id) {
    const label = doc.querySelector(`label[for="${cssEscape(id)}"]`);
    if (label) return getInnerText(label).trim();
  }
  // Walk ancestors looking for a wrapping <label>.
  let cur: Element | null = el.parentElement;
  while (cur) {
    if (cur.tagName === "LABEL") {
      // Inner text minus the input's own contribution.
      const clone = cur.cloneNode(true) as Element;
      const inputs = clone.querySelectorAll("input,select,textarea");
      inputs.forEach((i) => i.remove());
      return getInnerText(clone).trim();
    }
    cur = cur.parentElement;
  }
  return undefined;
}

function cssEscape(s: string): string {
  // Minimal CSS.escape polyfill for jsdom + browser.
  if (typeof (globalThis as any).CSS?.escape === "function") {
    return (globalThis as any).CSS.escape(s);
  }
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function normalizeAccname(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function accessibleName(el: Element, depth = 0): string {
  if (!el) return "";

  // 1. aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const out = resolveLabelledBy(
      el.ownerDocument as Document,
      labelledBy,
      depth,
    );
    if (out) return normalizeAccname(out);
  }

  // 2. aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return normalizeAccname(ariaLabel);

  const tag = el.tagName.toUpperCase();

  // 3a. <input type="submit|button|reset" value="X">
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") {
      const value = el.getAttribute("value");
      if (value) return normalizeAccname(value);
    }
    // 3b. associated label
    const label = findAssociatedLabel(el);
    if (label) return normalizeAccname(label);
    // 3c. placeholder fallback
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return normalizeAccname(placeholder);
    return "";
  }

  if (tag === "TEXTAREA" || tag === "SELECT") {
    const label = findAssociatedLabel(el);
    if (label) return normalizeAccname(label);
    return "";
  }

  // 4. <img alt>
  if (tag === "IMG") {
    const alt = el.getAttribute("alt");
    if (alt !== null) return normalizeAccname(alt);
    return "";
  }

  // 5. Inner text (button, link, heading, generic).
  const inner = normalizeAccname(getInnerText(el));
  if (inner) return inner;

  // 6. Shadow slot projection: if this element has slotted assignment,
  //    fall back to the assignedSlot's host text.
  const assignedSlot = (el as HTMLElement).assignedSlot;
  if (assignedSlot) {
    return accessibleName(assignedSlot, depth + 1);
  }

  return "";
}

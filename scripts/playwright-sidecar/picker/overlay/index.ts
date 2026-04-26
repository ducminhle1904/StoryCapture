// Overlay IIFE — runs inside every Playwright-driven page (injected via
// browserContext.addInitScript). Exposes `window.__sc_picker.{start,stop,
// isActive}` and emits ONE candidate payload per pick via the Playwright-
// bound `window.__sc_picker_emit` (see server.mjs `pickElement.start`).
//
// Wire contract (consumed by sidecar generator.mjs):
//   PickCandidatePayload {
//     testId?: string;             // [data-testid] attribute, if present
//     role?: string;               // implicit ARIA role
//     accessibleName?: string;     // axe-lite computed name
//     associatedLabel?: string;    // wrapping/<label for> name (if input)
//     visibleText?: string;        // trimmed inner text for non-input shapes
//     css: string;                 // @medv/finder fallback (shadow-piercing)
//     tagName: string;
//     shadowDepth: number;
//   }
// __cancel:true is sent on Esc.

import { accessibleName, inferRole } from "./axe-accessible-name-lite";
import { buildCss, shadowDepth } from "./finder-wrapper";

export interface PickCandidatePayload {
  testId?: string;
  role?: string;
  accessibleName?: string;
  associatedLabel?: string;
  visibleText?: string;
  css: string;
  tagName: string;
  shadowDepth: number;
  inputType?: string;
  isContentEditable?: boolean;
  isTextInput?: boolean;
  isSelect?: boolean;
  isFileInput?: boolean;
  optionLabels?: string[];
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "email",
  "password",
  "search",
  "url",
  "tel",
  "number",
]);

const OPTION_LABEL_LIMIT = 50;

/**
 * Element-shape metadata extracted at pick time. Pure DOM read so it can be
 * unit-tested in jsdom; exported for tests.
 */
export function buildElementMeta(el: Element): {
  inputType?: string;
  isContentEditable?: boolean;
  isTextInput?: boolean;
  isSelect?: boolean;
  isFileInput?: boolean;
  optionLabels?: string[];
} {
  const tag = el.tagName.toUpperCase();
  const inputType =
    tag === "INPUT"
      ? ((el as HTMLInputElement).type || "text").toLowerCase()
      : undefined;
  const isContentEditable =
    (el as HTMLElement).isContentEditable === true ||
    el.getAttribute("contenteditable") === "true" ||
    undefined;

  const isFileInput =
    tag === "INPUT" && inputType === "file" ? true : undefined;
  const isSelect = tag === "SELECT" ? true : undefined;
  const isTextInput =
    tag === "TEXTAREA" ||
    (tag === "INPUT" && !!inputType && TEXT_INPUT_TYPES.has(inputType)) ||
    isContentEditable === true
      ? true
      : undefined;

  let optionLabels: string[] | undefined;
  if (isSelect) {
    const opts = Array.from((el as HTMLSelectElement).options).slice(
      0,
      OPTION_LABEL_LIMIT,
    );
    const labels = opts
      .map((o) => (o.label || o.textContent || o.value || "").trim())
      .filter((s) => s.length > 0);
    if (labels.length > 0) optionLabels = labels;
  }

  return {
    inputType,
    isContentEditable,
    isTextInput,
    isSelect,
    isFileInput,
    optionLabels,
  };
}

export interface PickHoverPayload {
  testId?: string;
  role?: string;
  accessibleName?: string;
  boundingRect?: { x: number; y: number; width: number; height: number };
}

declare global {
  interface Window {
    __sc_picker?: {
      start: () => void;
      stop: () => void;
      isActive: () => boolean;
    };
    __sc_picker_emit?: (
      payload: PickCandidatePayload | { __cancel: true },
    ) => void;
    __sc_picker_hover?: (payload: PickHoverPayload) => Promise<void>;
    __sc_pick_target?: Element | null;
  }
}

// ─── Module-scope helpers (exported for unit tests) ─────────────────────
// Lifted out of the IIFE so vitest can drive them directly. The
// installPicker() closure below references them by name.

/**
 * Tags whose click target is intrinsically the tag itself — picking inside
 * one (e.g. icon `<svg>` inside `<button>`) should resolve to the tag.
 */
export const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "BUTTON",
  "A",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "SUMMARY",
  "LABEL",
]);

/**
 * ARIA roles that turn a generic element into a clickable widget.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "option",
  "treeitem",
]);

/** Cap on upward ancestor walk so a click never bubbles past 5 parents. */
export const INTERACTIVE_WALK_LIMIT = 5;

/** Maximum visible-text length baked into a DSL literal. */
export const VISIBLE_TEXT_CAP = 80;

/** True iff `el` is a button/link/input/[role=...]/[onclick]/[tabindex]/etc. */
export function isInteractive(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName.toUpperCase())) return true;
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute("onclick")) return true;
  if (el.hasAttribute("contenteditable")) return true;
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && tabindex !== "") return true;
  return false;
}

/**
 * Resolve a click event to the element the user *intended* to target.
 * Walks up at most `INTERACTIVE_WALK_LIMIT` ancestors looking for an
 * interactive element; returns the literal click point if none are found.
 *
 * Pure on `ev` — exported for tests; the IIFE wires it into `onClick`.
 */
export function findInteractiveTarget(ev: Event): Element | null {
  const path = (ev as any).composedPath ? (ev as any).composedPath() : [];
  let initial: Element | null = null;
  for (const node of path) {
    if (node instanceof Element) {
      initial = node;
      break;
    }
  }
  if (!initial && ev.target instanceof Element) initial = ev.target;
  if (!initial) return null;

  let cur: Element | null = initial;
  let steps = 0;
  while (cur && steps <= INTERACTIVE_WALK_LIMIT) {
    if (isInteractive(cur)) return cur;
    cur = cur.parentElement;
    steps++;
  }
  return initial;
}

/**
 * Build the candidate payload for an element. Pure DOM read; exported for
 * unit tests so they can assert visibleText leaf-direct extraction and the
 * 80-char cap without spinning up a click pipeline.
 */
export function buildPayload(el: Element): PickCandidatePayload {
  const testId = el.getAttribute("data-testid") || undefined;
  const role = inferRole(el);
  const name = accessibleName(el).trim() || undefined;

  let associatedLabel: string | undefined;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    associatedLabel = name;
  }

  let visibleText: string | undefined;
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
    let direct = "";
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3 /* Text */) direct += child.textContent || "";
    }
    let t = direct.replace(/\s+/g, " ").trim();
    if (!t) {
      t = (el.textContent || "").replace(/\s+/g, " ").trim();
    }
    if (t.length > VISIBLE_TEXT_CAP) t = t.slice(0, VISIBLE_TEXT_CAP).trim();
    if (t) visibleText = t;
  }

  return {
    testId,
    role,
    accessibleName: name,
    associatedLabel,
    visibleText,
    css: buildCss(el),
    tagName: tag,
    shadowDepth: shadowDepth(el),
    ...buildElementMeta(el),
  };
}

(function installPicker() {
  if (typeof window === "undefined") return;
  // Idempotent: addInitScript may run twice on context reuse.
  if (window.__sc_picker) return;

  let active = false;
  let highlight: HTMLDivElement | null = null;
  let lastTarget: Element | null = null;
  let rafHandle: number | null = null;

  function ensureHighlight(): HTMLDivElement {
    if (highlight) return highlight;
    const div = document.createElement("div");
    div.setAttribute("data-sc-picker-overlay", "");
    div.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "pointer-events:none",
      "border:2px solid #ff6a00",
      "background:rgba(255,106,0,0.08)",
      "transition:none",
      "top:0",
      "left:0",
      "width:0",
      "height:0",
      "box-sizing:border-box",
    ].join(";");
    document.documentElement.appendChild(div);
    highlight = div;
    return div;
  }

  function paintHighlight() {
    rafHandle = null;
    if (!active || !lastTarget) return;
    const r = lastTarget.getBoundingClientRect();
    const div = ensureHighlight();
    div.style.top = `${r.top}px`;
    div.style.left = `${r.left}px`;
    div.style.width = `${r.width}px`;
    div.style.height = `${r.height}px`;
  }

  function scheduleRepaint() {
    if (rafHandle != null) return;
    rafHandle = window.requestAnimationFrame(paintHighlight);
  }

  function onMouseOver(ev: MouseEvent) {
    if (!active) return;
    const target = findInteractiveTarget(ev);
    if (!target || target === lastTarget) return;
    lastTarget = target;
    scheduleRepaint();
    scheduleHoverEmit();
  }

  let hoverRafHandle: number | null = null;
  function scheduleHoverEmit() {
    if (hoverRafHandle != null) return;
    hoverRafHandle = window.requestAnimationFrame(() => {
      hoverRafHandle = null;
      if (!active || !lastTarget) return;
      const rect = lastTarget.getBoundingClientRect();
      const name = accessibleName(lastTarget).trim() || undefined;
      const payload: PickHoverPayload = {
        testId: lastTarget.getAttribute("data-testid") ?? undefined,
        role: inferRole(lastTarget),
        accessibleName: name,
        boundingRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
      const hover = window.__sc_picker_hover;
      if (typeof hover === "function") {
        hover(payload).catch(() => {});
      }
    });
  }

  function onClick(ev: MouseEvent) {
    if (!active) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const target = findInteractiveTarget(ev);
    if (!target) return;
    try {
      window.__sc_pick_target = target;
      const payload = buildPayload(target);
      if (typeof window.__sc_picker_emit === "function") {
        window.__sc_picker_emit(payload);
      }
    } finally {
      stop();
    }
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (!active) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      try {
        if (typeof window.__sc_picker_emit === "function") {
          window.__sc_picker_emit({ __cancel: true });
        }
      } finally {
        stop();
      }
    }
  }

  function start() {
    if (active) return;
    active = true;
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    ensureHighlight();
  }

  function stop() {
    if (!active) return;
    active = false;
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (highlight && highlight.parentNode) {
      highlight.parentNode.removeChild(highlight);
    }
    highlight = null;
    lastTarget = null;
    if (rafHandle != null) {
      window.cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    // cancel the pending hover emission too so a
    // post-stop() rAF callback doesn't invoke __sc_picker_hover.
    if (hoverRafHandle != null) {
      window.cancelAnimationFrame(hoverRafHandle);
      hoverRafHandle = null;
    }
  }

  function isActive() {
    return active;
  }

  window.__sc_picker = { start, stop, isActive };
})();

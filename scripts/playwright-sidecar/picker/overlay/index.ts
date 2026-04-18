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
}

// Plan 07-04a — live-hover preview payload.
// Lightweight on purpose: the chip only needs "what the user is pointing at
// right now" — the full ranked DSL emission still happens on click via
// __sc_picker_emit. The bindings writer in server.mjs (writeNotification)
// forwards this as an id-absent JSON-RPC `pickElement.hoverPreview`.
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
    // Plan 07-04a — fired on every rAF-throttled mouseover while picking.
    __sc_picker_hover?: (payload: PickHoverPayload) => Promise<void>;
  }
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

  function findInteractiveTarget(ev: Event): Element | null {
    // Use composedPath() so we pierce shadow DOM and find the user's
    // visible target rather than the shadow host.
    const path = (ev as any).composedPath ? (ev as any).composedPath() : [];
    for (const node of path) {
      if (node instanceof Element) return node;
    }
    return ev.target instanceof Element ? ev.target : null;
  }

  function onMouseOver(ev: MouseEvent) {
    if (!active) return;
    const target = findInteractiveTarget(ev);
    if (!target) return;
    lastTarget = target;
    scheduleRepaint();
    // Plan 07-04a — fire a hover-preview alongside the highlight repaint.
    // Re-uses the SAME rAF throttle (scheduleHoverEmit) so at most one
    // notification is emitted per animation frame (~60 Hz ceiling).
    scheduleHoverEmit();
  }

  // Plan 07-04a — rAF-throttled hover emission.
  //
  // Independent throttle from the paint scheduler because the hover
  // channel writes to stdout and we want to coalesce bursts (mouseover
  // fires on every nested child) rather than serialize every event.
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
        // Awaiting isn't useful — the binding resolves on the Node side
        // after stdout write. Swallow rejection so a torn-down page
        // during stop() doesn't surface an unhandled promise.
        hover(payload).catch(() => {});
      }
    });
  }

  function buildPayload(el: Element): PickCandidatePayload {
    const testId = el.getAttribute("data-testid") || undefined;
    const role = inferRole(el);
    const name = accessibleName(el).trim() || undefined;

    let associatedLabel: string | undefined;
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      // Reuse axe-lite logic by computing accessibleName which already
      // resolves label-for / wrapping label for form fields.
      associatedLabel = name;
    }

    let visibleText: string | undefined;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
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
    };
  }

  function onClick(ev: MouseEvent) {
    if (!active) return;
    // Block native nav/submit unconditionally so the user's pick doesn't
    // leave the page mid-flow.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const target = findInteractiveTarget(ev);
    if (!target) return;
    try {
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
    // Plan 07-04a — cancel the pending hover emission too so a
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

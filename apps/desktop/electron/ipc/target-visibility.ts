export const TARGET_SAFE_INSET_PX = 24;

export interface TargetPoint {
  x: number;
  y: number;
}

export interface TargetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TargetCoverDescriptor {
  tag: string;
  id: string | null;
  role: string | null;
  testId: string | null;
}

export interface TargetPointCandidate extends TargetPoint {
  coveredBy: TargetCoverDescriptor | null;
}

export interface TargetScrollerObservation {
  kind: "document" | "element";
  bounds: TargetRect;
  scroll: TargetPoint;
  maxScroll: TargetPoint;
  overflowX: string;
  overflowY: string;
}

export interface TargetVisibilityDiagnostics {
  bounds: TargetRect | null;
  viewportBounds: TargetRect;
  safeViewportBounds: TargetRect;
  clippedBounds: TargetRect | null;
  candidates: TargetPointCandidate[];
  selectedPoint: TargetPoint | null;
  cover: TargetCoverDescriptor | null;
  scrollers: TargetScrollerObservation[];
}

export type TargetVisibilityReason =
  | "detached"
  | "hidden"
  | "disabled"
  | "invalid_bounds"
  | "outside_viewport"
  | "covered";

export type TargetVisibilityObservation =
  | { status: "ready"; diagnostics: TargetVisibilityDiagnostics }
  | {
      status: "not_ready";
      reason: TargetVisibilityReason;
      diagnostics: TargetVisibilityDiagnostics;
    };

function rectFromEdges(left: number, top: number, right: number, bottom: number): TargetRect {
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

function insetRect(rect: TargetRect, inset: number): TargetRect {
  const xInset = Math.min(inset, rect.w / 2);
  const yInset = Math.min(inset, rect.h / 2);
  return rectFromEdges(
    rect.x + xInset,
    rect.y + yInset,
    rect.x + rect.w - xInset,
    rect.y + rect.h - yInset,
  );
}

function intersectRects(left: TargetRect, right: TargetRect): TargetRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.min(left.y + left.h, right.y + right.h);
  return rightEdge > x && bottomEdge > y ? rectFromEdges(x, y, rightEdge, bottomEdge) : null;
}

function finiteRect(rect: DOMRect): TargetRect | null {
  const values = [rect.left, rect.top, rect.width, rect.height];
  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

function isScrollableOverflow(value: string): boolean {
  return value === "auto" || value === "scroll" || value === "overlay";
}

function scrollableAxes(el: Element, style: CSSStyleDeclaration): { x: boolean; y: boolean } {
  const node = el as HTMLElement;
  return {
    x: isScrollableOverflow(style.overflowX) && node.scrollWidth > node.clientWidth,
    y: isScrollableOverflow(style.overflowY) && node.scrollHeight > node.clientHeight,
  };
}

function scrollerObservation(
  el: Element,
  kind: TargetScrollerObservation["kind"],
  bounds: TargetRect,
  style: CSSStyleDeclaration,
): TargetScrollerObservation {
  const node = el as HTMLElement;
  return {
    kind,
    bounds,
    scroll:
      kind === "document"
        ? { x: window.scrollX || node.scrollLeft || 0, y: window.scrollY || node.scrollTop || 0 }
        : { x: node.scrollLeft, y: node.scrollTop },
    maxScroll: {
      x: Math.max(0, node.scrollWidth - node.clientWidth),
      y: Math.max(0, node.scrollHeight - node.clientHeight),
    },
    overflowX: style.overflowX,
    overflowY: style.overflowY,
  };
}

function scrollableAncestors(el: Element, viewport: TargetRect): TargetScrollerObservation[] {
  const result: TargetScrollerObservation[] = [];
  let ancestor = el.parentElement;
  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    const axes = scrollableAxes(ancestor, style);
    if (axes.x || axes.y) {
      const bounds = finiteRect(ancestor.getBoundingClientRect());
      if (bounds) {
        result.push(scrollerObservation(ancestor, "element", bounds, style));
      }
    }
    ancestor = ancestor.parentElement;
  }

  const scrollingElement = document.scrollingElement || document.documentElement;
  const scrollingStyle = window.getComputedStyle(scrollingElement);
  result.push(scrollerObservation(scrollingElement, "document", viewport, scrollingStyle));
  return result;
}

function coverDescriptor(el: Element): TargetCoverDescriptor {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    role: el.getAttribute("role"),
    testId: el.getAttribute("data-testid"),
  };
}

function candidatePoints(rect: TargetRect): TargetPoint[] {
  const left = rect.x + Math.min(rect.w / 2, 1);
  const right = rect.x + rect.w - Math.min(rect.w / 2, 1);
  const top = rect.y + Math.min(rect.h / 2, 1);
  const bottom = rect.y + rect.h - Math.min(rect.h / 2, 1);
  const center = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  return [
    center,
    { x: center.x, y: top },
    { x: center.x, y: bottom },
    { x: left, y: center.y },
    { x: right, y: center.y },
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ].filter(
    (point, index, points) =>
      points.findIndex((candidate) => candidate.x === point.x && candidate.y === point.y) === index,
  );
}

function hitStackAt(point: TargetPoint): Element[] {
  if (typeof document.elementsFromPoint === "function") {
    return document.elementsFromPoint(point.x, point.y);
  }
  const hit = document.elementFromPoint(point.x, point.y);
  return hit ? [hit] : [];
}

function emptyDiagnostics(
  viewport: TargetRect,
  safeViewport: TargetRect,
): TargetVisibilityDiagnostics {
  return {
    bounds: null,
    viewportBounds: viewport,
    safeViewportBounds: safeViewport,
    clippedBounds: null,
    candidates: [],
    selectedPoint: null,
    cover: null,
    scrollers: [],
  };
}

export function targetVisibilityHelpersScript(): string {
  return [
    rectFromEdges,
    insetRect,
    intersectRects,
    finiteRect,
    isScrollableOverflow,
    scrollableAxes,
    scrollerObservation,
    scrollableAncestors,
    coverDescriptor,
    candidatePoints,
    hitStackAt,
    emptyDiagnostics,
    observeTargetVisibility,
  ]
    .map((helper) => helper.toString())
    .join("\n");
}

export function observeTargetVisibility(
  el: Element,
  requireEnabled: boolean,
  safeInsetPx = 24,
): TargetVisibilityObservation {
  const viewport = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const safeViewport = insetRect(viewport, Math.max(0, safeInsetPx));
  const empty = emptyDiagnostics(viewport, safeViewport);
  if (!el.isConnected) return { status: "not_ready", reason: "detached", diagnostics: empty };

  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") {
    return { status: "not_ready", reason: "hidden", diagnostics: empty };
  }
  if (
    requireEnabled &&
    (("disabled" in el && Boolean((el as HTMLButtonElement).disabled)) ||
      el.getAttribute("aria-disabled") === "true")
  ) {
    return { status: "not_ready", reason: "disabled", diagnostics: empty };
  }

  const bounds = finiteRect(el.getBoundingClientRect());
  if (!bounds) return { status: "not_ready", reason: "invalid_bounds", diagnostics: empty };

  const ancestors = scrollableAncestors(el, viewport);
  let clippedBounds: TargetRect | null = intersectRects(bounds, safeViewport);
  for (const ancestor of ancestors) {
    if (ancestor.kind === "element" && clippedBounds) {
      clippedBounds = intersectRects(
        clippedBounds,
        insetRect(ancestor.bounds, Math.max(0, safeInsetPx)),
      );
    }
  }

  const diagnostics: TargetVisibilityDiagnostics = {
    ...empty,
    bounds,
    clippedBounds,
    scrollers: ancestors,
  };
  if (!clippedBounds) {
    return { status: "not_ready", reason: "outside_viewport", diagnostics };
  }

  for (const point of candidatePoints(clippedBounds)) {
    const stack = hitStackAt(point);
    const top = stack[0] || null;
    const accepted = Boolean(top && (top === el || el.contains(top)));
    const candidate = {
      ...point,
      coveredBy: accepted || !top ? null : coverDescriptor(top),
    };
    diagnostics.candidates.push(candidate);
    if (accepted) {
      diagnostics.selectedPoint = point;
      diagnostics.cover = null;
      return { status: "ready", diagnostics };
    }
    if (!diagnostics.cover && candidate.coveredBy) diagnostics.cover = candidate.coveredBy;
  }

  return { status: "not_ready", reason: "covered", diagnostics };
}

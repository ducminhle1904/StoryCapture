import {
  type observeTargetVisibility,
  type TargetVisibilityDiagnostics,
  targetVisibilityHelpersScript,
} from "./target-visibility";

function textOf(el: Element): string {
  return ((el as HTMLElement).innerText || el.textContent || "").trim();
}

function cssEscape(value: string): string {
  return globalThis.CSS?.escape
    ? globalThis.CSS.escape(value)
    : value.replace(/["\\#.:,[\]>+~*^$|=]/g, "\\$&");
}

function formLabelOf(el: Element): string {
  const id = el.getAttribute("id");
  if (id) {
    const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
    if (label) return textOf(label);
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel) return textOf(wrappingLabel);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((idRef) => document.getElementById(idRef))
      .filter((label): label is HTMLElement => Boolean(label))
      .map(textOf)
      .join(" ")
      .trim();
  }
  return "";
}

function nameOf(el: Element): string {
  return (
    el.getAttribute("aria-label") ||
    formLabelOf(el) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("alt") ||
    textOf(el) ||
    ""
  ).trim();
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return "image";
  if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
  if (tag === "dialog") return "dialog";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (type === "image") return "button";
    return "textbox";
  }
  if (tag === "textarea") return "textbox";
  return "";
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return (
    rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
  );
}

function isEditableElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "input") return type !== "hidden";
  if (tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable || el.getAttribute("contenteditable") === "true")
    return true;
  return ["textbox", "combobox", "searchbox", "spinbutton"].includes(roleOf(el));
}

function isWritableElement(el: HTMLElement): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el.isContentEditable ||
    el.getAttribute("contenteditable") === "true" ||
    "value" in el
  );
}

export interface SimulatorResolvedTarget {
  kind: string;
  label: string | null;
  center: { x: number; y: number };
  bounds: { x: number; y: number; w: number; h: number };
}

export type SimulatorTargetReadiness =
  | {
      status: "ready";
      target: SimulatorResolvedTarget;
      diagnostics: TargetVisibilityDiagnostics;
    }
  | {
      status: "not_ready";
      reason:
        | "not_found"
        | "detached"
        | "hidden"
        | "disabled"
        | "invalid_bounds"
        | "outside_viewport"
        | "covered";
      diagnostics?: TargetVisibilityDiagnostics;
    };

function labelMatches(el: Element, needle: string): boolean {
  return (
    formLabelOf(el).toLowerCase().includes(needle) || nameOf(el).toLowerCase().includes(needle)
  );
}

export function findSimulatorTarget(
  target: unknown,
  targetNth?: number,
  selector?: string | null,
): Element | null {
  let matches: Element[] = [];
  if (selector) {
    try {
      matches = [...document.querySelectorAll(selector)];
    } catch {
      matches = [];
    }
  } else if (target && typeof target === "object") {
    const all = [...document.querySelectorAll("*")];
    const { kind, value } = target as { kind?: unknown; value?: unknown };
    if (kind === "label") {
      const needle = String(value).toLowerCase();
      const editableMatches = all.filter(
        (candidate) => isEditableElement(candidate) && labelMatches(candidate, needle),
      );
      matches =
        editableMatches.length > 0
          ? editableMatches
          : all.filter((candidate) => labelMatches(candidate, needle));
    } else if (kind === "text_exact") {
      matches = all.filter((candidate) => textOf(candidate) === String(value));
    } else if (kind === "text") {
      const needle = String(value).toLowerCase();
      matches = all.filter((candidate) => textOf(candidate).toLowerCase().includes(needle));
    } else if (kind === "role") {
      const roleTarget =
        value && typeof value === "object" ? (value as { role?: unknown; name?: unknown }) : null;
      const role = roleTarget ? String(roleTarget.role || "") : "";
      const name = roleTarget ? String(roleTarget.name || "").toLowerCase() : "";
      matches = all.filter((candidate) => {
        const candidateRole = roleOf(candidate);
        const tag = candidate.tagName.toLowerCase();
        const textboxCompatibleRole =
          role === "textbox" &&
          ["textbox", "combobox", "searchbox"].includes(candidateRole) &&
          (tag === "input" || tag === "textarea" || (candidate as HTMLElement).isContentEditable);
        return (
          (candidateRole === role || textboxCompatibleRole) &&
          (!name || nameOf(candidate).toLowerCase().includes(name))
        );
      });
    } else if (typeof value === "string") {
      const needle = value.toLowerCase();
      matches = all.filter((candidate) => {
        const text = nameOf(candidate).toLowerCase();
        return text === needle || text.includes(needle);
      });
    }
  }
  const visibleMatches = matches.filter(isVisible);
  const index = Number.isInteger(targetNth) && Number(targetNth) > 0 ? Number(targetNth) - 1 : 0;
  return visibleMatches[index] || matches[index] || null;
}

export function simulatorTargetLookupHelpersScript(): string {
  return [
    textOf,
    cssEscape,
    formLabelOf,
    nameOf,
    roleOf,
    isVisible,
    isEditableElement,
    labelMatches,
    findSimulatorTarget,
  ]
    .map((helper) => helper.toString())
    .join("\n");
}

export function simulatorTargetCenterScript(
  target: unknown,
  targetNth?: number,
  selector?: string | null,
): string {
  return `
    (() => {
      const target = (${simulatorTargetGeometryScript(target, targetNth, selector)});
      return target ? target.center : null;
    })()
  `;
}

function resolvedTargetGeometry(el: Element): SimulatorResolvedTarget {
  const rect = el.getBoundingClientRect();
  const label = nameOf(el);
  return {
    kind: "element",
    label: label || null,
    center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    bounds: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
  };
}

function resolvedTargetReadiness(
  el: Element | null,
  requireEnabled: boolean,
  observeVisibility: typeof observeTargetVisibility,
): SimulatorTargetReadiness {
  if (!el) return { status: "not_ready", reason: "not_found" };
  const visibility = observeVisibility(el, requireEnabled);
  if (visibility.status === "not_ready") return visibility;
  const target = resolvedTargetGeometry(el);
  return {
    status: "ready",
    target: {
      ...target,
      center: visibility.diagnostics.selectedPoint || target.center,
    },
    diagnostics: visibility.diagnostics,
  };
}

export function simulatorTargetReadinessScript(
  target: unknown,
  targetNth?: number,
  selector?: string | null,
  requireEnabled = true,
): string {
  return `
    (() => {
      ${textOf.toString()}
      ${cssEscape.toString()}
      ${formLabelOf.toString()}
      ${nameOf.toString()}
      ${roleOf.toString()}
      ${isVisible.toString()}
      ${isEditableElement.toString()}
      ${labelMatches.toString()}
      ${resolvedTargetGeometry.toString()}
      ${targetVisibilityHelpersScript()}
      ${resolvedTargetReadiness.toString()}
      const el = (${findSimulatorTarget.toString()})(
        ${JSON.stringify(target)},
        ${JSON.stringify(targetNth ?? null)},
        ${JSON.stringify(selector ?? null)}
      );
      return resolvedTargetReadiness(
        el,
        ${JSON.stringify(requireEnabled)},
        observeTargetVisibility
      );
    })()
  `;
}

export function simulatorTargetGeometryScript(
  target: unknown,
  targetNth?: number,
  selector?: string | null,
): string {
  return `
    (() => {
      ${textOf.toString()}
      ${cssEscape.toString()}
      ${formLabelOf.toString()}
      ${nameOf.toString()}
      ${roleOf.toString()}
      ${isVisible.toString()}
      ${isEditableElement.toString()}
      ${labelMatches.toString()}
      ${resolvedTargetGeometry.toString()}
      const el = (${findSimulatorTarget.toString()})(
        ${JSON.stringify(target)},
        ${JSON.stringify(targetNth ?? null)},
        ${JSON.stringify(selector ?? null)}
      );
      return el ? resolvedTargetGeometry(el) : null;
    })()
  `;
}

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

function assignElementValue(el: HTMLElement, value: string): boolean {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    setNativeValue(el, value);
  } else if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
    el.textContent = value;
  } else if ("value" in el) {
    (el as HTMLElement & { value: string }).value = value;
  } else {
    return false;
  }
  return true;
}

function writeElementValue(el: HTMLElement, value: string): boolean {
  if (!assignElementValue(el, value)) return false;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function setSimulatorTargetValue(el: Element | null, value: string): boolean {
  if (!el || !(el instanceof HTMLElement) || !isEditableElement(el)) return false;
  return writeElementValue(el, value);
}

function setResolvedTargetValue(el: Element | null, value: string): boolean {
  const target = resolvedEditableElement(el);
  return target ? writeElementValue(target, value) : false;
}

export function setActiveElementValue(value: string): boolean {
  const active = document.activeElement;
  if (!active || !(active instanceof HTMLElement)) return false;
  return writeElementValue(active, value);
}

function resolvedEditableElement(el: Element | null): HTMLElement | null {
  if (el instanceof HTMLElement && isEditableElement(el) && isWritableElement(el)) return el;
  if (!(el instanceof HTMLElement)) return null;
  const active = document.activeElement;
  if (active instanceof HTMLElement && (el === active || el.contains(active))) {
    if (isEditableElement(active) && isWritableElement(active)) return active;
  }
  const candidates = [...el.querySelectorAll("*")];
  for (const candidate of candidates) {
    if (
      candidate instanceof HTMLElement &&
      isEditableElement(candidate) &&
      isWritableElement(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

async function writeElementValueIncrementally(
  el: Element | null,
  value: string,
  delayMs: number,
): Promise<boolean> {
  const target = resolvedEditableElement(el);
  if (!target) return false;
  target.focus();
  const normalizedDelay = Math.max(0, Math.min(Number(delayMs) || 0, 250));
  const characters = Array.from(value);
  if (characters.length > 200) {
    if (!assignElementValue(target, value)) return false;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (target instanceof HTMLSelectElement) {
    if (!assignElementValue(target, value)) return false;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (!assignElementValue(target, "")) return false;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  let nextValue = "";
  for (const char of characters) {
    nextValue += char;
    if (!assignElementValue(target, nextValue)) return false;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    if (normalizedDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, normalizedDelay));
    }
  }
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function setActiveElementValueScript(value: string): string {
  return `
    (() => {
      ${setNativeValue.toString()}
      ${assignElementValue.toString()}
      ${writeElementValue.toString()}
      return (${setActiveElementValue.toString()})(${JSON.stringify(value)});
    })()
  `;
}

export function setSimulatorTargetValueScript(
  target: unknown,
  value: string,
  targetNth?: number,
  selector?: string | null,
): string {
  return `
    (() => {
      ${textOf.toString()}
      ${cssEscape.toString()}
      ${formLabelOf.toString()}
      ${nameOf.toString()}
      ${roleOf.toString()}
      ${isVisible.toString()}
      ${isEditableElement.toString()}
      ${isWritableElement.toString()}
      ${labelMatches.toString()}
      ${setNativeValue.toString()}
      ${assignElementValue.toString()}
      ${writeElementValue.toString()}
      ${setSimulatorTargetValue.toString()}
      ${resolvedEditableElement.toString()}
      ${setResolvedTargetValue.toString()}
      const el = (${findSimulatorTarget.toString()})(
        ${JSON.stringify(target)},
        ${JSON.stringify(targetNth ?? null)},
        ${JSON.stringify(selector ?? null)}
      );
      return setResolvedTargetValue(el, ${JSON.stringify(value)});
    })()
  `;
}

export function setSimulatorTargetValueIncrementalScript(
  target: unknown,
  value: string,
  targetNth?: number,
  selector?: string | null,
  delayMs = 35,
): string {
  return `
    (() => {
      ${textOf.toString()}
      ${cssEscape.toString()}
      ${formLabelOf.toString()}
      ${nameOf.toString()}
      ${roleOf.toString()}
      ${isVisible.toString()}
      ${isEditableElement.toString()}
      ${isWritableElement.toString()}
      ${labelMatches.toString()}
      ${setNativeValue.toString()}
      ${assignElementValue.toString()}
      ${writeElementValue.toString()}
      ${setSimulatorTargetValue.toString()}
      ${resolvedEditableElement.toString()}
      ${setResolvedTargetValue.toString()}
      ${writeElementValueIncrementally.toString()}
      const el = (${findSimulatorTarget.toString()})(
        ${JSON.stringify(target)},
        ${JSON.stringify(targetNth ?? null)},
        ${JSON.stringify(selector ?? null)}
      );
      return writeElementValueIncrementally(
        el,
        ${JSON.stringify(value)},
        ${JSON.stringify(delayMs)}
      );
    })()
  `;
}

export function simulatorTypeProbeScript(
  target: unknown,
  targetNth?: number,
  selector?: string | null,
  hashSalt = "",
): string {
  return `
    (async () => {
      ${textOf.toString()}
      ${cssEscape.toString()}
      ${formLabelOf.toString()}
      ${nameOf.toString()}
      ${roleOf.toString()}
      ${isVisible.toString()}
      ${isEditableElement.toString()}
      ${isWritableElement.toString()}
      ${labelMatches.toString()}
      ${resolvedEditableElement.toString()}
      const resolved = (${findSimulatorTarget.toString()})(
        ${JSON.stringify(target)},
        ${JSON.stringify(targetNth ?? null)},
        ${JSON.stringify(selector ?? null)}
      );
      const el = resolvedEditableElement(resolved);
      if (!el) return { found: false };
      const value = "value" in el ? String(el.value ?? "") : String(el.textContent ?? "");
      const bytes = new TextEncoder().encode(${JSON.stringify(hashSalt)} + value);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const valueHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      const path = [];
      let node = el;
      while (node && node.nodeType === Node.ELEMENT_NODE && path.length < 8) {
        let index = 1;
        let sibling = node.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === node.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        path.push(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
        node = node.parentElement;
      }
      return {
        found: true,
        connected: el.isConnected,
        active: document.activeElement === el,
        tag: el.tagName.toLowerCase(),
        inputType: el instanceof HTMLInputElement ? el.type : null,
        valueLength: Array.from(value).length,
        valueHash,
        selectionStart: "selectionStart" in el ? el.selectionStart : null,
        selectionEnd: "selectionEnd" in el ? el.selectionEnd : null,
        targetFingerprint: path.join(" > "),
        pageOrigin: location.origin,
      };
    })()
  `;
}

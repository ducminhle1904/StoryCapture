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
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function isEditableElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "input") return type !== "hidden";
  if (tag === "textarea" || tag === "select") return true;
  if ((el as HTMLElement).isContentEditable || el.getAttribute("contenteditable") === "true") return true;
  return ["textbox", "combobox", "searchbox", "spinbutton"].includes(roleOf(el));
}

function labelMatches(el: Element, needle: string): boolean {
  return formLabelOf(el).toLowerCase().includes(needle) || nameOf(el).toLowerCase().includes(needle);
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
      const roleTarget = value && typeof value === "object" ? (value as { role?: unknown; name?: unknown }) : null;
      const role = roleTarget ? String(roleTarget.role || "") : "";
      const name = roleTarget ? String(roleTarget.name || "").toLowerCase() : "";
      matches = all.filter(
        (candidate) => roleOf(candidate) === role && (!name || nameOf(candidate).toLowerCase().includes(name)),
      );
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

export function simulatorTargetCenterScript(
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
      const el = (${findSimulatorTarget.toString()})(
        ${JSON.stringify(target)},
        ${JSON.stringify(targetNth ?? null)},
        ${JSON.stringify(selector ?? null)}
      );
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

export function setActiveElementValue(value: string): boolean {
  const active = document.activeElement;
  if (!active || !(active instanceof HTMLElement)) return false;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement
  ) {
    setNativeValue(active, value);
  } else if (active.isContentEditable || active.getAttribute("contenteditable") === "true") {
    active.textContent = value;
  } else if ("value" in active) {
    (active as HTMLElement & { value: string }).value = value;
  } else {
    return false;
  }
  active.dispatchEvent(new Event("input", { bubbles: true }));
  active.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

export function setActiveElementValueScript(value: string): string {
  return `
    (() => {
      ${setNativeValue.toString()}
      return (${setActiveElementValue.toString()})(${JSON.stringify(value)});
    })()
  `;
}

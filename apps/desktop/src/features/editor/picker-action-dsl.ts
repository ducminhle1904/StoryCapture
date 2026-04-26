// Pure DSL builders for the picker action menu. The sidecar always emits
// `click ...`; this helper is the single source of truth for synthesising
// any other supported verb against the picked locator.

import type { PickLocator, PickPicked } from "@/ipc/picker";
import {
  parseLine,
  type ParsedLine,
  type TargetVerb,
} from "./picker-emit-rewrite";

export { parseLine as parsePickerLine };

const DEFAULT_WAIT_TIMEOUT = "5s";

/** Same escape semantics as sidecar `escapeDslString` — keep in sync. */
export function escapeDslString(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Convert a sidecar locator into the DSL fragment that follows the verb. */
export function formatPickedTarget(locator: PickLocator): string {
  switch (locator.kind) {
    case "testid":
      return `testid "${escapeDslString(stringValue(locator))}"`;
    case "role": {
      if (
        locator.value &&
        typeof locator.value === "object" &&
        "role" in locator.value &&
        "name" in locator.value
      ) {
        const { role, name } = locator.value;
        return `${role} "${escapeDslString(name)}"`;
      }
      throw new Error(
        `picker-action-dsl: role locator missing { role, name } shape`,
      );
    }
    case "label":
      return `field "${escapeDslString(stringValue(locator))}"`;
    case "text_exact":
    case "text":
      return `text "${escapeDslString(stringValue(locator))}"`;
    case "selector":
      return `selector "${escapeDslString(stringValue(locator))}"`;
    case "aria":
      return `aria "${escapeDslString(stringValue(locator))}"`;
    default:
      if (typeof locator.value === "string") {
        return `${locator.kind} "${escapeDslString(locator.value)}"`;
      }
      throw new Error(
        `picker-action-dsl: unsupported locator kind "${locator.kind}"`,
      );
  }
}

/**
 * Menu-header label for a picked element. Falls back to the sidecar's emitted
 * line (minus the leading verb) if the locator shape is unexpected so the
 * menu still has something to show.
 */
export function pickedTargetLabel(r: PickPicked): string {
  try {
    return formatPickedTarget(r.locator);
  } catch {
    return r.emitted.replace(/^[a-z][a-z-]*\s+/, "");
  }
}

function stringValue(locator: PickLocator): string {
  if (typeof locator.value !== "string") {
    throw new Error(
      `picker-action-dsl: locator kind "${locator.kind}" expects string value`,
    );
  }
  return locator.value;
}

/** Default menu selection — match the existing line's verb if recognised. */
export function inferDefaultAction(lineText: string): TargetVerb {
  return parseLine(lineText).verb ?? "click";
}

/**
 * Build the final DSL line. `parsed` is the result of `parseLine(existing)`;
 * pass it to preserve indent and any existing `wait-for ... timeout`. Returns
 * the line text without a trailing newline.
 */
export function buildPickerActionLine(
  action: TargetVerb,
  locator: PickLocator,
  parsed?: ParsedLine,
): string {
  const target = formatPickedTarget(locator);

  let body: string;
  if (action === "wait-for") {
    const timeout = extractTimeout(parsed?.trailing) ?? DEFAULT_WAIT_TIMEOUT;
    body = `wait-for ${target} timeout ${timeout}`;
  } else {
    body = `${action} ${target}`;
  }

  return parsed?.indent ? `${parsed.indent}${body}` : body;
}

function extractTimeout(trailing: string | undefined): string | null {
  if (!trailing) return null;
  const m = /^timeout\s+(\S+)/.exec(trailing);
  return m ? m[1] : null;
}

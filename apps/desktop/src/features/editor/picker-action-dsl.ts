// Pure DSL builders for the picker action menu. The sidecar always emits
// `click ...`; this helper is the single source of truth for synthesising
// any other supported verb against the picked locator.

import type { PickElementMeta, PickLocator, PickPicked } from "@/ipc/picker";
import type { Command, SelectorOrText } from "@/ipc/parse";
import {
  parseLine,
  TARGET_VERBS,
  type ParsedLine,
} from "./picker-emit-rewrite";

export { parseLine as parsePickerLine };

const DEFAULT_WAIT_TIMEOUT = "5s";

/**
 * Full picker-action superset. Includes target-only verbs (those handled
 * by {@link TargetVerb}), input-bearing verbs that require a value from
 * the user, and `drag` which needs a second pick. Order seeds the default
 * menu, which {@link getPickerActionItems} can re-rank from element shape.
 */
export const PICKER_ACTIONS = [
  "click",
  "hover",
  "wait-for",
  "assert",
  "fill",
  "type",
  "select",
  "upload",
  "drag",
] as const;

export type PickerAction = (typeof PICKER_ACTIONS)[number];

const PICKER_ACTION_SET: ReadonlySet<string> = new Set(PICKER_ACTIONS);

/**
 * Optional inputs collected from the action menu. Required keys depend on
 * the chosen action — {@link buildPickerActionLine} validates and throws on
 * missing required input.
 */
export interface PickerActionOptions {
  /** Required for `fill` and `type`. */
  text?: string;
  /** Required for `select`. */
  value?: string;
  /** Required for `upload`. */
  path?: string;
  /** Required for `drag` — the destination element's locator. */
  toLocator?: PickLocator;
}

const INPUT_ACTION_LABELS: Record<PickerAction, string> = {
  click: "Click element",
  hover: "Hover element",
  "wait-for": "Wait for element",
  assert: "Assert element",
  fill: "Fill text…",
  type: "Type text…",
  select: "Select option…",
  upload: "Upload file…",
  drag: "Drag from here…",
};

export interface PickerActionItem {
  action: PickerAction;
  label: string;
  /** True iff opening the action requires a follow-up form / pick session. */
  requiresInput: boolean;
}

const REQUIRES_INPUT: ReadonlySet<PickerAction> = new Set([
  "fill",
  "type",
  "select",
  "upload",
  "drag",
]);

export function pickerActionLabel(action: PickerAction): string {
  return INPUT_ACTION_LABELS[action];
}

export function pickerActionRequiresInput(action: PickerAction): boolean {
  return REQUIRES_INPUT.has(action);
}

/** Same escape semantics as sidecar `escapeDslString` — keep in sync. */
export function escapeDslString(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Convert a sidecar locator into the DSL fragment that follows the verb. */
export function formatPickedTarget(locator: PickLocator): string {
  const base = formatTargetBase(locator);
  return appendNth(base, locator.nth);
}

function formatTargetBase(locator: PickLocator): string {
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
        if (typeof role !== "string" || role.length === 0 || typeof name !== "string") {
          throw new Error(
            `picker-action-dsl: role locator missing { role, name } shape`,
          );
        }
        return `<${role}> "${escapeDslString(name)}"`;
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
 * Attach the optional `nth N` postfix to a target fragment. Postfix sits
 * on the TARGET — i.e. between the target and any verb-level modifier such
 * as `timeout 5s` or `with "x"` — so the builder calls this BEFORE composing
 * the final `<verb> <target>[ <modifier>]` line.
 */
function appendNth(target: string, nth: number | undefined): string {
  if (nth === undefined || nth === null) return target;
  if (!Number.isInteger(nth) || nth < 1) {
    throw new Error(
      `picker-action-dsl: nth must be a positive integer (got ${nth})`,
    );
  }
  return `${target} nth ${nth}`;
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

/**
 * Default menu selection — match the existing line's verb if it's any
 * recognised picker action. Falls back to `click` so the menu always
 * has a valid default.
 */
export function inferDefaultAction(lineText: string): PickerAction {
  // Strict target-shape parse first — preserves the contract for
  // click/hover/wait-for/assert with full locator structure.
  const targetVerb = parseLine(lineText).verb;
  if (targetVerb) return targetVerb;

  // Then accept any picker-action verb at line head (covers fill/type/
  // select/upload/drag whose lines don't match LINE_RE because of trailing
  // `with "x"` / second target).
  const m = /^\s*([a-z][a-z-]*)/.exec(lineText);
  if (m && PICKER_ACTION_SET.has(m[1])) return m[1] as PickerAction;
  return "click";
}

/**
 * Build the final DSL line. `parsed` is the result of `parseLine(existing)`;
 * pass it to preserve indent and any existing `wait-for ... timeout`.
 * `options` carries the user-provided inputs for verbs that need them.
 * Returns the line text without a trailing newline. Throws on missing
 * required input.
 */
export function buildPickerActionLine(
  action: PickerAction,
  locator: PickLocator,
  parsed?: ParsedLine,
  options?: PickerActionOptions,
): string {
  const target = formatPickedTarget(locator);

  let body: string;
  switch (action) {
    case "wait-for": {
      const timeout = extractTimeout(parsed?.trailing) ?? DEFAULT_WAIT_TIMEOUT;
      body = `wait-for ${target} timeout ${timeout}`;
      break;
    }
    case "fill": {
      const text = requireString(options?.text, "fill", "text");
      body = `fill ${target} with "${escapeDslString(text)}"`;
      break;
    }
    case "type": {
      const text = requireString(options?.text, "type", "text");
      body = `type ${target} "${escapeDslString(text)}"`;
      break;
    }
    case "select": {
      const value = requireString(options?.value, "select", "value");
      body = `select ${target} "${escapeDslString(value)}"`;
      break;
    }
    case "upload": {
      const path = requireString(options?.path, "upload", "path");
      body = `upload ${target} "${escapeDslString(path)}"`;
      break;
    }
    case "drag": {
      if (!options?.toLocator) {
        throw new Error(
          `picker-action-dsl: drag action requires options.toLocator`,
        );
      }
      const toTarget = formatPickedTarget(options.toLocator);
      body = `drag ${target} to ${toTarget}`;
      break;
    }
    case "click":
    case "hover":
    case "assert":
      body = `${action} ${target}`;
      break;
    default: {
      const exhaustive: never = action;
      throw new Error(`picker-action-dsl: unhandled action ${exhaustive}`);
    }
  }

  return parsed?.indent ? `${parsed.indent}${body}` : body;
}

/** Reject Picker output that the runtime parser interprets differently. */
export function validatePickerActionRoundTrip(
  action: PickerAction,
  locator: PickLocator,
  options: PickerActionOptions | undefined,
  command: Command | undefined,
): void {
  const expectedVerb = action === "fill" ? "type" : action;
  if (!command || command.verb !== expectedVerb) {
    throw pickerRoundTripError(
      locator,
      `runtime parser returned ${command?.verb ?? "no command"}`,
    );
  }

  if (action === "drag") {
    if (command.verb !== "drag") {
      throw pickerRoundTripError(locator, "runtime parser did not return drag");
    }
    assertParsedTarget(locator, command.from, command.from_nth, "source");
    if (!options?.toLocator) {
      throw pickerRoundTripError(locator, "drag destination is missing");
    }
    assertParsedTarget(options.toLocator, command.to, command.to_nth, "destination");
    return;
  }

  if (!("target" in command)) {
    throw pickerRoundTripError(locator, "runtime parser returned no target");
  }
  assertParsedTarget(locator, command.target, command.target_nth, "target");

  if ((action === "fill" || action === "type") && command.verb === "type") {
    assertParsedValue(locator, "text", options?.text, command.text);
  } else if (action === "select" && command.verb === "select") {
    assertParsedValue(locator, "value", options?.value, command.value);
  } else if (action === "upload" && command.verb === "upload") {
    assertParsedValue(locator, "path", options?.path, command.path);
  }
}

function assertParsedTarget(
  locator: PickLocator,
  actual: unknown,
  actualNth: number | undefined,
  label: string,
): void {
  if (!isSelectorOrText(actual)) {
    throw pickerRoundTripError(locator, `${label} has an invalid parsed shape`);
  }
  const expected = parsedTargetForLocator(locator);
  if (
    !parsedTargetsEqual(actual, expected) ||
    actualNth !== locator.nth
  ) {
    throw pickerRoundTripError(locator, `${label} changed during parse-back`);
  }
}

function isSelectorOrText(value: unknown): value is SelectorOrText {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !("value" in value)
  ) {
    return false;
  }
  const target = value as { kind: unknown; value: unknown };
  if (target.kind === "role") {
    return (
      target.value !== null &&
      typeof target.value === "object" &&
      "role" in target.value &&
      typeof target.value.role === "string" &&
      "name" in target.value &&
      typeof target.value.name === "string"
    );
  }
  return (
    typeof target.value === "string" &&
    ["text", "selector", "test_id", "aria", "label", "text_exact"].includes(
      String(target.kind),
    )
  );
}

function parsedTargetsEqual(
  actual: SelectorOrText,
  expected: SelectorOrText,
): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === "role" && expected.kind === "role") {
    return (
      actual.value.role === expected.value.role &&
      actual.value.name === expected.value.name
    );
  }
  return actual.value === expected.value;
}

function assertParsedValue(
  locator: PickLocator,
  label: string,
  expected: string | undefined,
  actual: string,
): void {
  if (actual !== expected) {
    throw pickerRoundTripError(locator, `${label} changed during parse-back`);
  }
}

function parsedTargetForLocator(locator: PickLocator): SelectorOrText {
  switch (locator.kind) {
    case "testid":
      return { kind: "test_id", value: stringValue(locator) };
    case "role": {
      if (
        locator.value &&
        typeof locator.value === "object" &&
        "role" in locator.value &&
        "name" in locator.value
      ) {
        return { kind: "role", value: locator.value };
      }
      throw pickerRoundTripError(locator, "role locator shape is malformed");
    }
    case "label":
      return { kind: "label", value: stringValue(locator) };
    case "text_exact":
    case "text":
      return { kind: "text", value: stringValue(locator) };
    case "selector":
      return { kind: "selector", value: stringValue(locator) };
    case "aria":
      return { kind: "aria", value: stringValue(locator) };
    default:
      throw pickerRoundTripError(locator, `locator kind ${locator.kind} is unsupported`);
  }
}

function pickerRoundTripError(locator: PickLocator, detail: string): Error {
  const roleHint =
    locator.kind === "role" &&
    locator.value &&
    typeof locator.value === "object" &&
    "role" in locator.value
      ? ` Expected canonical <${locator.value.role}> target.`
      : "";
  return new Error(
    `Picker target validation failed: ${detail}.${roleHint} The action was not inserted.`,
  );
}

function requireString(
  value: string | undefined,
  action: string,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `picker-action-dsl: ${action} action requires options.${field}`,
    );
  }
  return value;
}

function extractTimeout(trailing: string | undefined): string | null {
  if (!trailing) return null;
  const m = /^timeout\s+(\S+)/.exec(trailing);
  return m ? m[1] : null;
}

/**
 * Context-aware action ordering. The four target-only verbs are always
 * present; element metadata only promotes the matching input verb to the
 * top so the right action lands under the default focus ring without
 * hiding the rest of the menu (reordering is safer than hiding).
 */
export function getPickerActionItems(
  meta?: PickElementMeta,
): PickerActionItem[] {
  const base: PickerAction[] = [...TARGET_VERBS];
  let promoted: PickerAction[] = [];

  if (meta?.isTextInput) promoted.push("fill", "type");
  else if (meta?.isSelect) promoted.push("select");
  else if (meta?.isFileInput) promoted.push("upload");

  // Drag is never promoted — it needs a second pick and only makes sense
  // when the user explicitly opts in.
  const ordered: PickerAction[] = [...promoted, ...base, "drag"];

  return ordered.map((action) => ({
    action,
    label: pickerActionLabel(action),
    requiresInput: pickerActionRequiresInput(action),
  }));
}

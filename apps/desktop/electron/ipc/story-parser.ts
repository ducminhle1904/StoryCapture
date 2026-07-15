import { createHash } from "node:crypto";
import {
  parseTextOverlayDuration,
  TEXT_OVERLAY_DEFAULT_DURATION_MS,
  validateTextOverlayText,
} from "../../src/ipc/text-overlay";

export type ParsedCommandVerb =
  | "navigate"
  | "click"
  | "hover"
  | "assert"
  | "assert-visible"
  | "type"
  | "select"
  | "upload"
  | "drag"
  | "scroll"
  | "wait"
  | "text-overlay"
  | "wait-for"
  | "wait-for-visible"
  | "screenshot"
  | "pause";

export interface ParsedCommand {
  verb: ParsedCommandVerb;
  span: { start: number; end: number; line: number; col: number };
  step_id?: string | null;
  url?: string;
  target?: unknown;
  target_nth?: number;
  from?: unknown;
  from_nth?: number;
  to?: unknown;
  to_nth?: number;
  text?: string;
  value?: string;
  path?: string;
  direction?: string;
  amount?: number | null;
  unit?: "px" | "vh";
  duration_ms?: number;
  timeout_ms?: number | null;
  name?: string;
  scene_id?: string;
  scene_name?: string;
  scene_ordinal?: number;
  step_ordinal?: number;
}

export interface ParsedCommandSceneContext {
  scene_id: string;
  scene_name: string;
  scene_ordinal: number;
  step_ordinal: number;
}

export function parsedCommandSceneId(
  storyName: string | null,
  sceneOrdinal: number,
  sceneName: string,
): string {
  const normalized = (value: string | null) =>
    (value ?? "story").normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase();
  const identity = `${normalized(storyName)}\0${sceneOrdinal}\0${normalized(sceneName)}`;
  return `scene_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

const ROLE_KEYWORDS = new Set([
  "button",
  "link",
  "heading",
  "image",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "menu",
  "option",
  "combobox",
  "listbox",
  "dialog",
  "alert",
  "tooltip",
  "switch",
  "slider",
  "row",
  "cell",
  "navigation",
  "main",
  // Compatibility input for pre-canonical Picker output. New Picker output
  // always uses the generic `<role> "name"` form instead of this allowlist.
  "textbox",
]);

const TARGET_PREFIX_KIND: Record<string, string> = {
  aria: "aria",
  field: "label",
  label: "label",
  selector: "selector",
  test_id: "test_id",
  testid: "test_id",
  text: "text",
  text_exact: "text_exact",
};

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed
      .slice(1, -1)
      .replaceAll(/\\"/g, '"')
      .replaceAll(/\\'/g, "'")
      .replaceAll(/\\\\/g, "\\");
  }
  return trimmed;
}

function lineSpan(lineStart: number, line: string, lineNo: number) {
  return { start: lineStart, end: lineStart + line.length, line: lineNo, col: 1 };
}

function parseDurationMs(raw: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "m") return Math.round(value * 60_000);
  if (unit === "s") return Math.round(value * 1000);
  return Math.round(value);
}

function readToken(input: string): { token: string; rest: string } | null {
  const text = input.trimStart();
  if (!text) return null;
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let escaped = false;
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        return { token: text.slice(0, index + 1), rest: text.slice(index + 1).trimStart() };
      }
    }
    return { token: text, rest: "" };
  }
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { token: match[1], rest: match[2]?.trimStart() ?? "" };
}

function parseQuotedTextToken(token: string): string | null {
  const quote = token[0];
  if ((quote !== '"' && quote !== "'") || token.length < 2) return null;

  let escaped = false;
  for (let index = 1; index < token.length; index += 1) {
    const char = token[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === quote) return index === token.length - 1 ? stripQuotes(token) : null;
  }
  return null;
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function targetWithNth(
  target: unknown,
  rest: string,
): { target: unknown; target_nth?: number; rest: string } {
  const nth = rest.match(/^nth\s+(\d+)(?:\s+([\s\S]*))?$/);
  if (!nth) return { target, rest };
  return {
    target,
    target_nth: Number(nth[1]),
    rest: nth[2]?.trimStart() ?? "",
  };
}

export function parseTargetFragment(raw: string): {
  target: unknown;
  target_nth?: number;
  rest: string;
} {
  const text = raw.trim();
  const first = readToken(text);
  if (!first) return { target: { kind: "text", value: "" }, rest: "" };
  if (first.token.startsWith("<") && first.token.endsWith(">")) {
    const role = first.token.slice(1, -1);
    const name = readToken(first.rest);
    return targetWithNth(
      { kind: "role", value: { role, name: stripQuotes(name?.token ?? "") } },
      name?.rest ?? "",
    );
  }
  if (first.token.startsWith('"') || first.token.startsWith("'")) {
    return targetWithNth({ kind: "text_exact", value: stripQuotes(first.token) }, first.rest);
  }
  const prefixKind = TARGET_PREFIX_KIND[first.token];
  if (prefixKind) {
    const value = readToken(first.rest);
    return targetWithNth(
      { kind: prefixKind, value: stripQuotes(value?.token ?? "") },
      value?.rest ?? "",
    );
  }
  if (ROLE_KEYWORDS.has(first.token)) {
    const name = readToken(first.rest);
    return targetWithNth(
      { kind: "role", value: { role: first.token, name: stripQuotes(name?.token ?? "") } },
      name?.rest ?? "",
    );
  }
  const nth = text.match(/^(.*?)\s+nth\s+(\d+)(?:\s+([\s\S]*))?$/);
  if (nth) {
    return {
      target: { kind: "text", value: stripQuotes(nth[1]) },
      target_nth: Number(nth[2]),
      rest: nth[3]?.trimStart() ?? "",
    };
  }
  return { target: { kind: "text", value: stripQuotes(text) }, rest: "" };
}

export function parseTarget(raw: string): unknown {
  return parseTargetFragment(raw).target;
}

type ParsedCommandBase = Pick<ParsedCommand, "span" | "step_id">;

function parseTextOverlayCommand(
  rest: string,
  base: ParsedCommandBase,
): { command: ParsedCommand | null; message?: string } {
  const parsedText = readToken(rest);
  const text = parsedText ? parseQuotedTextToken(parsedText.token) : null;
  if (text == null) {
    return {
      command: null,
      message:
        'Text overlay text must be a quoted string, for example: text-overlay "Title" 2000ms.',
    };
  }

  const textError = validateTextOverlayText(text);
  if (textError) return { command: null, message: textError };

  if (!parsedText?.rest) {
    return {
      command: {
        verb: "text-overlay",
        text,
        duration_ms: TEXT_OVERLAY_DEFAULT_DURATION_MS,
        ...base,
      },
    };
  }

  const duration = parseTextOverlayDuration(parsedText.rest);
  if (duration.error || duration.durationMs == null) {
    return { command: null, message: duration.error ?? "Invalid text overlay duration." };
  }

  return {
    command: { verb: "text-overlay", text, duration_ms: duration.durationMs, ...base },
  };
}

function parseTargetOnlyCommand(
  verb: "click" | "hover" | "assert" | "assert-visible",
  rest: string,
  base: ParsedCommandBase,
): ParsedCommand {
  const parsed = parseTargetFragment(rest);
  return { verb, target: parsed.target, target_nth: parsed.target_nth, ...base };
}

function parseValueCommand(
  verb: "type" | "select" | "upload",
  rest: string,
  base: ParsedCommandBase,
): ParsedCommand {
  const parsed = parseTargetFragment(rest);
  const valueRest = parsed.rest.replace(/^with\s+/, "");
  const value = stripQuotes(valueRest);
  return {
    verb,
    target: parsed.target,
    target_nth: parsed.target_nth,
    [verb === "upload" ? "path" : verb === "select" ? "value" : "text"]: value,
    ...base,
  };
}

function parseWaitForCommand(
  verb: "wait-for" | "wait-for-visible",
  rest: string,
  base: ParsedCommandBase,
): ParsedCommand {
  const parsed = parseTargetFragment(rest);
  const timeout = parsed.rest.match(/^timeout\s+(\S+)$/);
  return {
    verb,
    target: parsed.target,
    target_nth: parsed.target_nth,
    timeout_ms: timeout ? parseDurationMs(timeout[1]) : null,
    ...base,
  };
}

function parseScrollCommand(
  rest: string,
  base: ParsedCommandBase,
): { command: ParsedCommand | null; message?: string } {
  const direct = rest.match(/^(up|down|left|right)(?:\s+(\S+))?$/);
  let target: unknown;
  let targetNth: number | undefined;
  let direction: "up" | "down" | "left" | "right";
  let amountRaw: string | undefined;

  if (direct) {
    direction = direct[1] as typeof direction;
    amountRaw = direct[2];
  } else {
    const targeted = rest.match(/^(.+?)\s+(up|down|left|right)(?:\s+(\S+))?$/);
    if (!targeted) {
      return {
        command: null,
        message: "scroll expects [target] direction [amount(px|vh)]",
      };
    }
    const parsed = parseTargetFragment(targeted[1]);
    if (parsed.rest) {
      return { command: null, message: "scroll target is invalid" };
    }
    target = parsed.target;
    targetNth = parsed.target_nth;
    direction = targeted[2] as typeof direction;
    amountRaw = targeted[3];
  }

  const amountMatch = amountRaw?.match(/^(\d+(?:\.\d+)?|\.\d+)(px|vh)?$/);
  if (amountRaw && !amountMatch) {
    return {
      command: null,
      message: "scroll amount must be a positive finite number with px or vh units",
    };
  }
  const amount = amountMatch ? Number(amountMatch[1]) : 500;
  if (amount <= 0) {
    return {
      command: null,
      message: "scroll amount must be a positive finite number",
    };
  }

  return {
    command: {
      verb: "scroll",
      ...(target === undefined ? {} : { target, target_nth: targetNth }),
      direction,
      amount,
      unit: (amountMatch?.[2] as "px" | "vh" | undefined) ?? "px",
      ...base,
    },
  };
}

function parseDragCommand(rest: string, base: ParsedCommandBase): ParsedCommand {
  const from = parseTargetFragment(rest);
  const to = parseTargetFragment(from.rest.replace(/^to\s+/, ""));
  return {
    verb: "drag",
    from: from.target,
    from_nth: from.target_nth,
    to: to.target,
    to_nth: to.target_nth,
    ...base,
  };
}

export function parseStorySource(source: string) {
  const diagnostics: unknown[] = [];
  const story = {
    name: null as string | null,
    meta: {
      app: null as string | null,
      viewport: null as { width: number; height: number } | null,
      theme: null as string | null,
      speed: null as number | null,
      span: { start: 0, end: 0, line: 1, col: 1 },
    },
    scenes: [] as Array<{
      name: string;
      commands: unknown[];
      span: { start: number; end: number; line: number; col: number };
    }>,
    span: { start: 0, end: source.length, line: 1, col: 1 },
  };
  let currentScene: (typeof story.scenes)[number] | null = null;
  let inMeta = false;
  const lines = source.split(/\r?\n/);
  let offset = 0;

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const span = lineSpan(offset, line, lineNo);
    const stepId = line.match(/#\s*@id=([0-9a-fA-F-]{36})/)?.[1] ?? null;
    const trimmed = stripLineComment(line).trim();
    offset += line.length + 1;
    if (!trimmed || trimmed === "}") {
      if (trimmed === "}") inMeta = false;
      return;
    }
    const storyMatch = trimmed.match(/^story(?:\s+(.+?))?\s*\{?$/);
    if (storyMatch) {
      story.name = storyMatch[1] ? stripQuotes(storyMatch[1]) : null;
      return;
    }
    if (/^meta\s*\{?$/.test(trimmed)) {
      inMeta = true;
      story.meta.span = span;
      return;
    }
    const sceneMatch = trimmed.match(/^scene\s+(.+?)\s*\{?$/);
    if (sceneMatch) {
      currentScene = { name: stripQuotes(sceneMatch[1]), commands: [], span };
      story.scenes.push(currentScene);
      inMeta = false;
      return;
    }
    if (inMeta) {
      const meta = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.+)$/);
      if (!meta) return;
      const [, key, rawValue] = meta;
      if (key === "app") story.meta.app = stripQuotes(rawValue);
      if (key === "theme") story.meta.theme = stripQuotes(rawValue);
      if (key === "speed") story.meta.speed = Number(rawValue);
      if (key === "viewport") {
        const viewport = rawValue.match(/^(\d+)x(\d+)$/);
        story.meta.viewport = viewport
          ? { width: Number(viewport[1]), height: Number(viewport[2]) }
          : rawValue.trim() === "desktop"
            ? { width: 1440, height: 900 }
            : rawValue.trim() === "mobile"
              ? { width: 390, height: 844 }
              : null;
      }
      return;
    }
    if (!currentScene) {
      diagnostics.push({
        severity: "warning",
        message: "command outside scene ignored",
        span,
        suggestion: null,
      });
      return;
    }
    const parts = trimmed.split(/\s+/);
    const verb = parts[0];
    const rest = trimmed.slice(verb.length).trim();
    const base = { span, step_id: stepId };
    let command: unknown | null = null;
    if (verb === "navigate") command = { verb, url: stripQuotes(rest), ...base };
    if (verb === "click" || verb === "hover" || verb === "assert" || verb === "assert-visible") {
      command = parseTargetOnlyCommand(verb, rest, base);
    }
    if (verb === "type" || verb === "select" || verb === "upload") {
      command = parseValueCommand(verb, rest, base);
    }
    if (verb === "fill") command = parseValueCommand("type", rest, base);
    if (verb === "drag") command = parseDragCommand(rest, base);
    if (verb === "scroll") {
      const parsed = parseScrollCommand(rest, base);
      command = parsed.command;
      if (parsed.message) {
        diagnostics.push({
          severity: "error",
          message: parsed.message,
          span,
          suggestion: "Use: scroll [target] down 300px",
        });
      }
    }
    if (verb === "wait") command = { verb, duration_ms: parseDurationMs(rest), ...base };
    if (verb === "text-overlay") {
      const parsed = parseTextOverlayCommand(rest, base);
      command = parsed.command;
      if (parsed.message) {
        diagnostics.push({
          severity: "error",
          message: parsed.message,
          span,
          suggestion: 'Use: text-overlay "Text" 2000ms',
        });
      }
    }
    if (verb === "wait-for" || verb === "wait-for-visible") {
      command = parseWaitForCommand(verb, rest, base);
    }
    if (verb === "screenshot")
      command = { verb, name: stripQuotes(rest || `shot-${lineNo}`), ...base };
    if (verb === "pause") command = { verb, ...base };
    if (command) {
      const sceneOrdinal = story.scenes.indexOf(currentScene) + 1;
      const stepOrdinal = currentScene.commands.length + 1;
      currentScene.commands.push({
        ...(command as ParsedCommand),
        scene_id: parsedCommandSceneId(story.name, sceneOrdinal, currentScene.name),
        scene_name: currentScene.name,
        scene_ordinal: sceneOrdinal,
        step_ordinal: stepOrdinal,
      });
    } else if (verb !== "scroll" && verb !== "text-overlay" && !["{", "}"].includes(trimmed)) {
      diagnostics.push({
        severity: "error",
        message: `unknown command: ${verb}`,
        span,
        suggestion: null,
      });
    }
  });

  return { ast: story.scenes.length ? story : null, diagnostics };
}

export function parsedCommands(source: string): ParsedCommand[] {
  const parsed = parseStorySource(source);
  const ast = parsed.ast as { scenes?: Array<{ commands?: unknown[] }> } | null;
  return (ast?.scenes?.flatMap((scene) => scene.commands ?? []) ?? []) as ParsedCommand[];
}

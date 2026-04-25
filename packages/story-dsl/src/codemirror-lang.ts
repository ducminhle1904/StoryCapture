/**
 * Lightweight CodeMirror tokenizer for the StoryCapture DSL.
 *
 * It uses `StreamLanguage` because the grammar is line-oriented.
 * Diagnostics still come from `parse_story` via the diagnostics bridge.
 */

import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

/** DSL verbs from `grammar.pest`. */
export const KNOWN_VERBS = [
  "navigate",
  "click",
  "type",
  "scroll",
  "hover",
  "drag",
  "select",
  "upload",
  "wait",
  "wait-for",
  "assert",
  "screenshot",
  "pause",
] as const;

/** Meta keys. */
export const KNOWN_META_KEYS = ["app", "viewport", "theme", "speed"] as const;

/** Selector target prefixes. */
export const KNOWN_TARGET_PREFIXES = ["selector", "testid", "aria"] as const;

/** Top-level blocks. */
export const KNOWN_BLOCKS = ["story", "meta", "scene"] as const;

/** Scroll directions. */
export const KNOWN_SCROLL_DIRS = ["up", "down", "left", "right"] as const;

/** Theme values. */
export const KNOWN_THEMES = ["light", "dark", "auto"] as const;

const VERB_SET = new Set<string>(KNOWN_VERBS);
const META_SET = new Set<string>(KNOWN_META_KEYS);
const TARGET_SET = new Set<string>(KNOWN_TARGET_PREFIXES);
const BLOCK_SET = new Set<string>(KNOWN_BLOCKS);
const DIR_SET = new Set<string>(KNOWN_SCROLL_DIRS);
const THEME_SET = new Set<string>(KNOWN_THEMES);

export const storyDslStreamLanguage = StreamLanguage.define({
  name: "storycapture-dsl",
  startState: () => ({}),
  token(stream): string | null {
    // Line comment.
    if (stream.match(/#.*/)) return "comment";
    // Single-line block-comment match; parser handles full multi-line parsing.
    if (stream.match(/\/\*[\s\S]*?\*\//)) return "comment";
    // Strings.
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";
    // Numbers with optional units.
    if (stream.match(/-?\b\d+(?:\.\d+)?(?:ms|s|m|h|px|%)?\b/)) return "number";
    // Braces and punctuation.
    if (stream.match(/[{}(),:]/)) return "punctuation";
    // Identifiers and keywords.
    const word = stream.match(/[a-zA-Z_][a-zA-Z0-9_-]*/);
    if (word) {
      const w = (word as RegExpMatchArray)[0];
      if (BLOCK_SET.has(w)) return "keyword";
      if (VERB_SET.has(w)) return "atom";
      if (META_SET.has(w)) return "propertyName";
      if (TARGET_SET.has(w)) return "typeName";
      if (DIR_SET.has(w) || THEME_SET.has(w)) return "variableName";
      return "variableName";
    }
    stream.next();
    return null;
  },
  tokenTable: {
    atom: t.atom,
    keyword: t.keyword,
    propertyName: t.propertyName,
    typeName: t.typeName,
    variableName: t.variableName,
    string: t.string,
    number: t.number,
    comment: t.comment,
    punctuation: t.punctuation,
  },
});

/** Highlight style backed by design tokens. */
export const storyDslHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--sc-accent-500)", fontWeight: "600" },
  { tag: t.atom, color: "var(--sc-accent-600)", fontWeight: "600" },
  { tag: t.propertyName, color: "var(--sc-text)" },
  { tag: t.typeName, color: "var(--sc-info)" },
  { tag: t.variableName, color: "var(--sc-text)" },
  { tag: t.string, color: "var(--sc-success)" },
  { tag: t.number, color: "var(--sc-warn)" },
  { tag: t.comment, color: "var(--sc-text-3)", fontStyle: "italic" },
  { tag: t.punctuation, color: "var(--sc-text-2)" },
]);

/** Language + highlight bundle. */
export function storyDsl(): Extension {
  return [new LanguageSupport(storyDslStreamLanguage), syntaxHighlighting(storyDslHighlightStyle)];
}

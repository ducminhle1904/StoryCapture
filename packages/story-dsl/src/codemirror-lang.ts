/**
 * CodeMirror 6 language pack for the StoryCapture DSL (UI-02).
 *
 * Uses `StreamLanguage` (not Lezer) because the DSL grammar is line-oriented
 * and tokens don't span lines. The authoritative grammar lives in
 * `crates/story-parser/src/grammar.pest`; this module only needs to tokenize
 * well enough for syntax highlighting + autocomplete anchors.
 *
 * Diagnostics are NOT produced here — the renderer calls the
 * `parse_story` Tauri command and feeds the returned `Diagnostic[]`
 * into `@codemirror/lint`'s `linter()` extension (see
 * `apps/desktop/src/features/editor/diagnostics-bridge.ts`).
 */

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { LanguageSupport } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

/** 13 DSL verbs from the grammar (see crates/story-parser/src/grammar.pest). */
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

/** Meta block keys. */
export const KNOWN_META_KEYS = ["app", "viewport", "theme", "speed"] as const;

/** Target prefixes for the selector-or-text value types. */
export const KNOWN_TARGET_PREFIXES = ["selector", "testid", "aria"] as const;

/** Top-level block keywords. */
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
    // Line comment (# ...)
    if (stream.match(/#.*/)) return "comment";
    // Block comment /* ... */ — naive single-line match; the parser handles
    // multi-line blocks fine, CM virtualization makes per-line matching OK.
    if (stream.match(/\/\*[^]*?\*\//)) return "comment";
    // Strings ("..." or '...')
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/'(?:[^'\\]|\\.)*'/)) return "string";
    // Numbers (including units like 500ms, 1.5s)
    if (stream.match(/-?\b\d+(?:\.\d+)?(?:ms|s|m|h|px|%)?\b/)) return "number";
    // Braces / punctuation
    if (stream.match(/[{}(),:]/)) return "punctuation";
    // Identifiers / keywords
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

/** Highlight style bound to design-system CSS variables (UI-08). */
export const storyDslHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--color-accent-primary)", fontWeight: "600" },
  { tag: t.atom, color: "var(--color-accent-secondary)", fontWeight: "600" },
  { tag: t.propertyName, color: "var(--color-fg-primary)" },
  { tag: t.typeName, color: "var(--color-waveform)" },
  { tag: t.variableName, color: "var(--color-fg-primary)" },
  { tag: t.string, color: "var(--color-success)" },
  { tag: t.number, color: "var(--color-warning)" },
  { tag: t.comment, color: "var(--color-fg-muted)", fontStyle: "italic" },
  { tag: t.punctuation, color: "var(--color-fg-secondary)" },
]);

/** CodeMirror LanguageSupport bundle: language + highlight style. */
export function storyDsl(): Extension {
  return [
    new LanguageSupport(storyDslStreamLanguage),
    syntaxHighlighting(storyDslHighlightStyle),
  ];
}

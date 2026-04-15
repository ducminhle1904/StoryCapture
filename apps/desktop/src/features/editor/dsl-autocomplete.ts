/**
 * CodeMirror 6 completion source for the DSL (UI-02).
 *
 * Phase 1 scope (D-37, D-38):
 *   - Static completions: 13 verbs + meta keys + target prefixes + top-level blocks.
 *   - Dynamic selector completions (live DOM via `fetch_dom_selectors`) are
 *     deferred — Plan 06 doesn't expose that command yet. We surface a
 *     zero-result stub so the infrastructure is wired when P06 adds it.
 */

import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import {
  KNOWN_VERBS,
  KNOWN_META_KEYS,
  KNOWN_TARGET_PREFIXES,
} from "@/features/editor/dsl-language";

const VERB_OPTIONS = KNOWN_VERBS.map((v) => ({ label: v, type: "keyword" }));
const META_OPTIONS = KNOWN_META_KEYS.map((k) => ({
  label: k,
  type: "property",
}));
const TARGET_OPTIONS = KNOWN_TARGET_PREFIXES.map((p) => ({
  label: p,
  type: "type",
}));
const BLOCK_OPTIONS = [
  { label: "story", type: "keyword" },
  { label: "scene", type: "keyword" },
  { label: "meta", type: "keyword" },
];

function dslCompletionSource(
  ctx: CompletionContext,
): CompletionResult | null {
  const word = ctx.matchBefore(/[a-zA-Z_][a-zA-Z0-9_-]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;

  // Pull up to 200 chars of preceding text to pick which option set applies.
  const before = ctx.state.sliceDoc(Math.max(0, word.from - 200), word.from);
  const inMeta = /\bmeta\s*\{[^}]*$/.test(before);
  const inScene = /\bscene\s+"[^"]*"\s*\{[^}]*$/.test(before);
  const afterTargetVerb = /\b(click|hover|assert|wait-for|type|select|upload|drag)\s+$/.test(
    before,
  );

  const options = inMeta
    ? META_OPTIONS
    : afterTargetVerb
      ? TARGET_OPTIONS
      : inScene
        ? [...VERB_OPTIONS, ...TARGET_OPTIONS]
        : BLOCK_OPTIONS.concat(VERB_OPTIONS);

  return { from: word.from, options, validFor: /^[a-zA-Z_][a-zA-Z0-9_-]*$/ };
}

export const storyAutocomplete = autocompletion({
  override: [dslCompletionSource],
});

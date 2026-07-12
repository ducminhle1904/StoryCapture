/**
 * CodeMirror 6 completion source for the DSL.
 *
 * Static completions only: verbs + meta keys + target prefixes + top-level
 * blocks. Dynamic live-DOM selector completions are deferred.
 */

import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import {
  KNOWN_META_KEYS,
  KNOWN_TARGET_PREFIXES,
  KNOWN_VERBS,
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

function dslCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/[a-zA-Z_][a-zA-Z0-9_-]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;

  // Pull up to 200 chars of preceding text to pick which option set applies.
  const before = ctx.state.sliceDoc(Math.max(0, word.from - 200), word.from);
  const inMeta = /\bmeta\s*\{[^}]*$/.test(before);
  const inScene = /\bscene\s+"[^"]*"\s*\{[^}]*$/.test(before);
  const afterTargetVerb =
    /\b(click|hover|assert(?:-visible)?|wait-for(?:-visible)?|type|select|upload|drag|scroll)\s+$/.test(
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

// Thin re-export so editor features don't reach across the workspace more
// than once. The actual grammar + highlight style lives in
// `@storycapture/story-dsl/codemirror-lang`.
export { storyDsl, KNOWN_VERBS, KNOWN_META_KEYS, KNOWN_TARGET_PREFIXES }
  from "@storycapture/story-dsl";

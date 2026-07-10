import {
  KNOWN_BLOCKS,
  KNOWN_META_KEYS,
  KNOWN_TARGET_PREFIXES,
  KNOWN_VERBS,
} from "@storycapture/story-dsl";
import { describe, expect, it } from "vitest";

import { VERB_DOCS } from "./dsl-docs";

describe("VERB_DOCS coverage", () => {
  it.each([...KNOWN_VERBS])("documents verb '%s'", (verb) => {
    expect(VERB_DOCS).toHaveProperty(verb);
    const doc = VERB_DOCS[verb];
    expect(doc.description.length).toBeGreaterThan(0);
    expect(doc.example.length).toBeGreaterThan(0);
  });

  it.each([...KNOWN_META_KEYS])("documents meta key '%s'", (key) => {
    expect(VERB_DOCS).toHaveProperty(key);
  });

  it.each([...KNOWN_TARGET_PREFIXES])("documents target prefix '%s'", (p) => {
    expect(VERB_DOCS).toHaveProperty(p);
  });

  it.each([...KNOWN_BLOCKS])("documents top-level block '%s'", (b) => {
    expect(VERB_DOCS).toHaveProperty(b);
  });
});

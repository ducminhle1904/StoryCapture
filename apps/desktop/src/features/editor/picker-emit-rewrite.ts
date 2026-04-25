/**
 * Rewrite the picker's emitted DSL line so it matches the verb + trailing
 * modifier of an existing line. The sidecar's emit always uses verb `click`
 * and no modifier; non-programmer users expect `hover`/`wait-for`/`assert`
 * to be preserved when they re-pick a target on those lines.
 *
 * Pure helper — no editor state. Tested in isolation.
 */

// Verbs we'll preserve when rewriting. All are target-only at the head;
// only `wait-for` carries a known trailing modifier (`timeout <duration>`).
export const TARGET_VERBS = ["click", "hover", "assert", "wait-for"] as const;
export type TargetVerb = (typeof TARGET_VERBS)[number];

interface ParsedLine {
  indent: string;
  verb: TargetVerb | null;
  /** Trailing modifier text after the target (e.g. `timeout 5s`), no leading space. */
  trailing: string;
  /** True iff the line has shape `<verb> <strategy> "<value>"[ <modifier>]`. */
  hasTargetShape: boolean;
}

const LINE_RE =
  /^(?<indent>\s*)(?<verb>[a-z][a-z-]*)\s+(?<strategy>[a-zA-Z][\w-]*)\s+"(?:\\"|[^"])*"(?<trailing>.*)$/;

export function parseLine(text: string): ParsedLine {
  const m = LINE_RE.exec(text);
  if (!m || !m.groups) {
    return { indent: "", verb: null, trailing: "", hasTargetShape: false };
  }
  const verb = m.groups.verb as string;
  const known = (TARGET_VERBS as readonly string[]).includes(verb)
    ? (verb as TargetVerb)
    : null;
  return {
    indent: m.groups.indent ?? "",
    verb: known,
    trailing: m.groups.trailing.trimStart(),
    hasTargetShape: true,
  };
}

/**
 * Combine the sidecar's emitted line with the existing line's verb +
 * trailing modifier. Returns the rewritten line text (no newline).
 *
 * - emitted shape: `click <strategy> "<value>"`
 * - When `existing.verb` is a known target verb, replace `click` with it.
 * - When `existing.trailing` is non-empty, append it (e.g. ` timeout 5s`).
 * - When `existing.indent` is non-empty, prepend it (preserves DSL indent).
 */
export function rewriteEmitted(emitted: string, existing: ParsedLine): string {
  let out = emitted;
  // Only rewrite verb + preserve trailing when the existing verb is one we
  // know matches `<verb> <target>` semantics. For unknown verbs (e.g.
  // `type ... with "x"`) the trailing carries verb-specific syntax that
  // doesn't apply to a click-style target swap.
  if (existing.verb !== null) {
    if (emitted.startsWith("click ")) {
      out = `${existing.verb} ${emitted.slice("click ".length)}`;
    }
    if (existing.trailing) {
      out = `${out} ${existing.trailing}`;
    }
  }
  if (existing.indent) {
    out = `${existing.indent}${out}`;
  }
  return out;
}

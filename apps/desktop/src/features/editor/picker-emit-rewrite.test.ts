import { describe, expect, it } from "vitest";

import { parseLine, rewriteEmitted } from "./picker-emit-rewrite";

describe("parseLine", () => {
  it("parses indent + known verb + target shape", () => {
    expect(parseLine('    hover link "Rust (programming language)"')).toEqual({
      indent: "    ",
      verb: "hover",
      trailing: "",
      hasTargetShape: true,
    });
  });

  it("captures trailing modifier (timeout)", () => {
    expect(parseLine('    wait-for link "Rust (programming language)" timeout 5s')).toEqual({
      indent: "    ",
      verb: "wait-for",
      trailing: "timeout 5s",
      hasTargetShape: true,
    });
  });

  it("returns verb=null for unknown verbs (still has target shape)", () => {
    const r = parseLine('  type field "Search" with "x"');
    expect(r.verb).toBeNull();
    expect(r.hasTargetShape).toBe(true);
  });

  it("returns no-target-shape for blank or scene-boundary lines", () => {
    expect(parseLine("").hasTargetShape).toBe(false);
    expect(parseLine('  scene "x" {').hasTargetShape).toBe(false);
    expect(parseLine("  }").hasTargetShape).toBe(false);
  });
});

describe("rewriteEmitted", () => {
  it("keeps `click` when existing line has unknown verb", () => {
    const out = rewriteEmitted('click link "Rust"', parseLine('    type field "Search" with "x"'));
    expect(out).toBe('    click link "Rust"');
  });

  it("rewrites verb to match existing line", () => {
    const out = rewriteEmitted(
      'click link "Rust"',
      parseLine('    hover link "Rust (programming language)"'),
    );
    expect(out).toBe('    hover link "Rust"');
  });

  it("preserves trailing modifier (timeout)", () => {
    const out = rewriteEmitted(
      'click link "Rust"',
      parseLine('    wait-for link "Rust (programming language)" timeout 5s'),
    );
    expect(out).toBe('    wait-for link "Rust" timeout 5s');
  });

  it("falls back cleanly when existing line has no shape", () => {
    const out = rewriteEmitted('click link "Rust"', parseLine(""));
    expect(out).toBe('click link "Rust"');
  });
});

import { describe, expect, it } from "vitest";

import type { Diagnostic as HostDiagnostic } from "@/ipc/parse";

import { hostDiagnosticsToCm } from "./diagnostics-bridge";

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function diagnostic(start: number, end: number): HostDiagnostic {
  return {
    severity: "error",
    message: "bad verb",
    suggestion: "click",
    span: {
      start,
      end,
      line: 1,
      col: 1,
    },
  };
}

describe("diagnostics-bridge", () => {
  function convert(source: string, start: number, end: number) {
    return hostDiagnosticsToCm(source, [diagnostic(start, end)])[0];
  }

  it("keeps ASCII byte spans mapped to the same CodeMirror offsets", () => {
    const source = 'scene "Intro"\n  clik "Save"\n';
    const start = source.indexOf("clik");
    const end = start + "clik".length;

    const cm = convert(source, start, end);

    expect(cm).toMatchObject({
      from: start,
      to: end,
      severity: "error",
      message: 'bad verb (did you mean "click"?)',
    });
  });

  it("converts UTF-8 byte spans to CodeMirror string offsets", () => {
    const source = 'scene "Café"\n  clik "Save"\n';
    const start = source.indexOf("clik");
    const end = start + "clik".length;
    const byteStart = byteLength(source.slice(0, start));
    const byteEnd = byteLength(source.slice(0, end));

    const cm = convert(source, byteStart, byteEnd);

    expect(byteStart).toBeGreaterThan(start);
    expect(cm.from).toBe(start);
    expect(cm.to).toBe(end);
  });

  it("clamps parser byte spans beyond the document to a valid range", () => {
    const source = "x".repeat(323);

    const cm = convert(source, 388, 389);

    expect(cm.from).toBe(322);
    expect(cm.to).toBe(323);
  });

  it("normalizes reversed spans without exceeding the document", () => {
    const source = "abcdef";

    const cm = convert(source, 5, 2);

    expect(cm.from).toBe(5);
    expect(cm.to).toBe(6);
  });

  it("keeps empty-document diagnostics within the only valid range", () => {
    const cm = convert("", Number.NaN, Number.POSITIVE_INFINITY);

    expect(cm.from).toBe(0);
    expect(cm.to).toBe(0);
  });
});

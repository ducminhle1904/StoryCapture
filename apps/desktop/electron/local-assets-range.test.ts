import { describe, expect, it } from "vitest";

import { parseByteRange } from "./local-assets-range";

describe("parseByteRange", () => {
  it("uses a full response when no range was requested", () => {
    expect(parseByteRange(null, 10)).toEqual({ kind: "full" });
  });

  it.each([
    ["bytes=2-5", { kind: "partial", start: 2, end: 5 }],
    ["bytes=7-", { kind: "partial", start: 7, end: 9 }],
    ["bytes=-3", { kind: "partial", start: 7, end: 9 }],
    ["bytes=8-30", { kind: "partial", start: 8, end: 9 }],
  ])("parses %s", (header, expected) => {
    expect(parseByteRange(header, 10)).toEqual(expected);
  });

  it.each([
    "bytes=10-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=0-1,4-5",
    "items=0-1",
  ])("rejects unsatisfiable or unsupported range %s", (header) => {
    expect(parseByteRange(header, 10)).toEqual({ kind: "unsatisfiable" });
  });
});

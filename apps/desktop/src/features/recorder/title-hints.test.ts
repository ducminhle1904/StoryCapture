/**
 * Plan 06-03 — Task 0 unit tests for the browser title-hint map.
 */
import { describe, it, expect } from "vitest";
import {
  BROWSER_TITLE_HINTS,
  redactTitleHint,
  titleHintFor,
} from "./title-hints";

describe("BROWSER_TITLE_HINTS", () => {
  it("contains the canonical preset tokens", () => {
    expect(BROWSER_TITLE_HINTS["chromium"]).toBe("Chromium");
    expect(BROWSER_TITLE_HINTS["chrome"]).toBe("Google Chrome");
    expect(BROWSER_TITLE_HINTS["chrome-canary"]).toBe("Google Chrome Canary");
    expect(BROWSER_TITLE_HINTS["msedge"]).toBe("Microsoft Edge");
    expect(BROWSER_TITLE_HINTS["brave"]).toBe("Brave Browser");
    expect(BROWSER_TITLE_HINTS["arc"]).toBe("Arc");
  });
});

describe("titleHintFor — preset key lookup", () => {
  it("resolves msedge → Microsoft Edge", () => {
    expect(titleHintFor("msedge")).toBe("Microsoft Edge");
  });

  it("resolves chrome-canary → Google Chrome Canary", () => {
    expect(titleHintFor("chrome-canary")).toBe("Google Chrome Canary");
  });

  it("resolves chrome → Google Chrome", () => {
    expect(titleHintFor("chrome")).toBe("Google Chrome");
  });

  it("resolves brave → Brave Browser", () => {
    expect(titleHintFor("brave")).toBe("Brave Browser");
  });

  it("is case-insensitive on preset keys", () => {
    expect(titleHintFor("MSEDGE")).toBe("Microsoft Edge");
    expect(titleHintFor("Chrome-Canary")).toBe("Google Chrome Canary");
  });
});

describe("titleHintFor — graceful failure", () => {
  it("returns undefined for undefined input (never defaults to Chromium)", () => {
    expect(titleHintFor(undefined)).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(titleHintFor(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(titleHintFor("")).toBeUndefined();
  });

  it("returns undefined for unknown preset (non-Chromium like firefox)", () => {
    // D-11 + D-15: non-Chromium browsers have no `--app` equivalent and
    // no title-hint mapping; the auto-follow path falls back to
    // pid-only match via the Phase 5 find_window_by_pid.
    expect(titleHintFor("firefox")).toBeUndefined();
    expect(titleHintFor("safari")).toBeUndefined();
  });
});

describe("titleHintFor — exec path heuristics", () => {
  it("resolves macOS Chrome app wrapper path", () => {
    expect(
      titleHintFor(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    ).toBe("Google Chrome");
  });

  it("resolves macOS Edge app wrapper path", () => {
    expect(
      titleHintFor(
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ),
    ).toBe("Microsoft Edge");
  });

  it("resolves Chrome Canary path before Chrome", () => {
    expect(
      titleHintFor(
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      ),
    ).toBe("Google Chrome Canary");
  });

  it("resolves Edge Beta path before Edge", () => {
    expect(
      titleHintFor(
        "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
      ),
    ).toBe("Microsoft Edge Beta");
  });

  it("resolves Brave app wrapper path", () => {
    expect(
      titleHintFor(
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ),
    ).toBe("Brave Browser");
  });

  it("resolves Arc app wrapper path", () => {
    expect(titleHintFor("/Applications/Arc.app/Contents/MacOS/Arc")).toBe(
      "Arc",
    );
  });
});

describe("redactTitleHint — T-06-15 log redaction", () => {
  it("returns <none> for undefined/null/empty", () => {
    expect(redactTitleHint(undefined)).toBe("<none>");
    expect(redactTitleHint(null)).toBe("<none>");
    expect(redactTitleHint("")).toBe("<none>");
  });

  it("passes through short hints untouched", () => {
    expect(redactTitleHint("Microsoft Edge")).toBe("Microsoft Edge");
  });

  it("truncates hints >40 chars with ellipsis", () => {
    const long = "A".repeat(80);
    const out = redactTitleHint(long);
    expect(out.length).toBeLessThanOrEqual(41); // 40 + "…"
    expect(out.endsWith("…")).toBe(true);
  });
});

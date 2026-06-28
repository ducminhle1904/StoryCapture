import { describe, expect, it } from "vitest";

import { sameNavigationUrl } from "./navigation-url";

describe("navigation URL helpers", () => {
  it("matches equivalent HTTP navigation URLs after URL normalization", () => {
    expect(
      sameNavigationUrl(
        "https://app.example.test/login",
        "https://app.example.test/login",
      ),
    ).toBe(true);
    expect(
      sameNavigationUrl(
        "https://app.example.test",
        "https://app.example.test/",
      ),
    ).toBe(true);
  });

  it("does not match different paths or query strings", () => {
    expect(
      sameNavigationUrl(
        "https://app.example.test/login",
        "https://app.example.test/app",
      ),
    ).toBe(false);
    expect(
      sameNavigationUrl(
        "https://app.example.test/login",
        "https://app.example.test/login?redirect=/app/bots",
      ),
    ).toBe(false);
  });

  it("does not match invalid or non-browser URLs", () => {
    expect(
      sameNavigationUrl("about:blank", "https://app.example.test/login"),
    ).toBe(false);
    expect(
      sameNavigationUrl(
        "https://app.example.test/login",
        "mailto:support@example.test",
      ),
    ).toBe(false);
  });
});

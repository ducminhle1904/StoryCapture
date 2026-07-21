import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
] as const;

for (const viewport of viewports) {
  test(`Gothic landing foundation at ${viewport.name}`, async ({ browserName, page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/", { waitUntil: "networkidle" });

    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-astryx-anchor-positioning",
      "polyfill",
    );
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const pageState = await page.evaluate(() => ({
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));
    expect(pageState.colorScheme).toContain("dark");
    expect(pageState.hasHorizontalOverflow).toBe(false);
    expect(pageState.reducedMotion).toBe(true);

    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName ?? "BODY"))
      .not.toBe("BODY");

    const accessibility = await new AxeBuilder({ page }).analyze();
    const blockingViolations = accessibility.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(blockingViolations).toEqual([]);
  });
}

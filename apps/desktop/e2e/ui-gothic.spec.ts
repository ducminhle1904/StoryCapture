import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const axeRequire = createRequire(require.resolve("@axe-core/playwright"));
const axeScriptPath = axeRequire.resolve("axe-core/axe.min.js");
const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "compact", width: 1024, height: 700 },
] as const;

for (const size of sizes) {
  test(`Electron Gothic shell at ${size.name}`, async () => {
    const app = await electron.launch({
      args: [desktopDir],
      cwd: desktopDir,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: "http://127.0.0.1:1420",
      },
    });

    try {
      const main =
        app.windows().find((window) => window.url().startsWith("http://127.0.0.1:1420")) ??
        (await app.waitForEvent("window", {
          predicate: (window) => window.url().startsWith("http://127.0.0.1:1420"),
        }));
      await app.evaluate(({ BrowserWindow }, windowSize) => {
        BrowserWindow.getAllWindows()[0]?.setSize(windowSize.width, windowSize.height);
      }, size);
      await expect(main.locator("#root > *").first()).toBeVisible({ timeout: 15_000 });
      await main.emulateMedia({ reducedMotion: "reduce" });
      await main.evaluate(() => {
        window.history.pushState({}, "", "/onboarding");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      await expect(main.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(main.getByRole("heading", { level: 1 })).toBeVisible();

      const shellState = await main.evaluate(() => ({
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      }));
      expect(shellState.colorScheme).toContain("dark");
      expect(shellState.hasHorizontalOverflow).toBe(false);
      expect(shellState.reducedMotion).toBe(true);

      await main.keyboard.press("Tab");
      await expect
        .poll(() => main.evaluate(() => document.activeElement?.tagName ?? "BODY"))
        .not.toBe("BODY");

      await main.addScriptTag({ path: axeScriptPath });
      const accessibility = await main.evaluate(async () => {
        const axe = (
          window as unknown as {
            axe: {
              run: (context: Document) => Promise<{
                violations: Array<{
                  id: string;
                  impact: string | null;
                  nodes: Array<{ target: string[]; failureSummary: string }>;
                }>;
              }>;
            };
          }
        ).axe;
        return axe.run(document);
      });
      const blockingViolations = accessibility.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failureSummary: node.failureSummary,
          })),
        }));
      expect(blockingViolations).toEqual([]);
    } finally {
      await app.close();
    }
  });
}

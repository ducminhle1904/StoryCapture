import { expect, test, type Page } from "@playwright/test";

const contractPath = (screen = "gallery", state?: string, theme = "dark") => {
  const params = new URLSearchParams({
    contract: "desktop-v2.1",
    screen,
    theme,
    density: "desktop",
  });
  if (state) params.set("state", state);
  return `/?${params.toString()}`;
};

async function openStable(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [
    { width: 1440, height: 1024, label: "1440x1024" },
    { width: 1280, height: 800, label: "1280x800" },
  ]) {
    test(`desktop contract gallery ${theme} ${viewport.label}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openStable(page, contractPath("gallery", undefined, theme));
      await expect(page).toHaveScreenshot(`desktop-contract-gallery-${theme}-${viewport.label}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });
  }
}

const canonicalScreens = [
  ["dashboard", "populated"],
  ["author", "valid"],
  ["preview", "running"],
  ["recorder", "completed"],
  ["post-production", "review"],
  ["export", "ready"],
  ["settings", "general"],
  ["onboarding", "goal"],
] as const;

for (const [screen, state] of canonicalScreens) {
  test(`canonical ${screen} ${state}`, async ({ page }) => {
    await openStable(page, contractPath(screen, state));
    await expect(page).toHaveScreenshot(`desktop-${screen}-${state}-dark-1440x1024.png`, {
      animations: "disabled",
    });
  });
}

const riskStates = [
  ["dashboard", "empty"],
  ["dashboard", "loading"],
  ["dashboard", "error"],
  ["author", "invalid"],
  ["preview", "failed"],
  ["preview", "complete"],
  ["recorder", "verifying"],
  ["recorder", "failed"],
  ["post-production", "export-blocked"],
] as const;

for (const [screen, state] of riskStates) {
  test(`risk state ${screen} ${state}`, async ({ page }) => {
    await openStable(page, contractPath(screen, state));
    await expect(page).toHaveScreenshot(`desktop-${screen}-${state}-dark-1440x1024.png`, {
      animations: "disabled",
    });
  });
}

for (const [screen, state] of [
  ["preview", "running"],
  ["recorder", "recording"],
  ["post-production", "review"],
] as const) {
  test(`reduced motion ${screen} ${state}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openStable(page, contractPath(screen, state));
    await expect(page).toHaveScreenshot(
      `desktop-${screen}-${state}-reduced-motion-dark-1440x1024.png`,
      { animations: "disabled" },
    );
  });
}

for (const [theme, density] of [
  ["dark", "desktop"],
  ["light", "desktop"],
  ["dark", "web"],
  ["light", "web"],
] as const) {
  test(`component catalog ${theme} ${density}`, async ({ page }) => {
    await openStable(page, `/?theme=${theme}&density=${density}`);
    await expect(page).toHaveScreenshot(`component-catalog-${theme}-${density}.png`, {
      fullPage: true,
      animations: "disabled",
    });
  });
}

test("component catalog dialog", async ({ page }) => {
  await openStable(page, "/?theme=dark&density=desktop");
  await page.getByRole("button", { name: "Open export dialog" }).click();
  await expect(page).toHaveScreenshot("component-catalog-dialog-dark-desktop.png", {
    fullPage: true,
    animations: "disabled",
  });
});

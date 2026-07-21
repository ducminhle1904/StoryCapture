import { defineConfig } from "@playwright/test";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e/ui",
  timeout: 60_000,
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: `pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      AUTH_SECRET: process.env.AUTH_SECRET ?? "storycapture-astryx-ui-e2e-secret",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://storycapture:storycapture@127.0.0.1:5432/storycapture",
      NEXT_PUBLIC_UI_FORCE_ANCHOR_FALLBACK: "1",
    },
  },
});

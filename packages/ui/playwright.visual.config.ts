import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./visual-tests",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:4176",
    viewport: { width: 1440, height: 1024 },
    colorScheme: "dark",
  },
  webServer: {
    command: "pnpm catalog --host 127.0.0.1",
    url: "http://127.0.0.1:4176/",
    reuseExistingServer: true,
  },
});

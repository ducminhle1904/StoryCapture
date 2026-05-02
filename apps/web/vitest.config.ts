import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: [
      {
        find: "@/lib/auth",
        replacement: new URL("./src/test/auth.ts", import.meta.url).pathname,
      },
      {
        find: "@/lib/prisma",
        replacement: new URL("./src/test/prisma.ts", import.meta.url).pathname,
      },
      {
        find: "server-only",
        replacement: new URL("./src/test/server-only.ts", import.meta.url).pathname,
      },
      {
        find: "@",
        replacement: new URL("./src", import.meta.url).pathname,
      },
    ],
  },
});

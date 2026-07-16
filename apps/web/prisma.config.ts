import "dotenv/config";

import { defineConfig } from "prisma/config";

const datasource = process.env.DATABASE_URL
  ? { datasource: { url: process.env.DATABASE_URL } }
  : {};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  ...datasource,
});

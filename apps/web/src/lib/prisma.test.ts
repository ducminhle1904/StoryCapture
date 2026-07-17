import { afterEach, describe, expect, it, vi } from "vitest";

const globalForPrisma = globalThis as unknown as { prisma?: unknown };
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  delete globalForPrisma.prisma;
  vi.resetModules();
});

describe("prisma singleton", () => {
  it("loads without database configuration but rejects the first database access", async () => {
    delete process.env.DATABASE_URL;
    delete globalForPrisma.prisma;
    vi.resetModules();

    const { prisma } = await import("./prisma");

    expect(() => prisma.user).toThrow("DATABASE_URL is required to create a Prisma client");
  });
});

import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/lib/create-prisma-client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createLazyPrismaClient(): PrismaClient {
  let client: PrismaClient | undefined;

  // Next imports server modules while collecting build metadata, when a
  // database URL is intentionally optional. Runtime access still validates the
  // URL through the shared factory before node-postgres can apply PG* defaults.
  return new Proxy({} as PrismaClient, {
    get(_target, property) {
      client ??= createPrismaClient();
      const value = Reflect.get(client, property, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

export const prisma = globalForPrisma.prisma ?? createLazyPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

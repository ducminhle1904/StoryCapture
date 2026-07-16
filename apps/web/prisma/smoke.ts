import "dotenv/config";

import { randomUUID } from "node:crypto";

import { createPrismaClient } from "../src/lib/create-prisma-client";

const prisma = createPrismaClient();
const email = `prisma-smoke-${randomUUID()}@example.invalid`;
let userId: string | undefined;

try {
  const created = await prisma.user.create({ data: { email } });
  userId = created.id;

  const loaded = await prisma.user.findUnique({ where: { email } });
  if (loaded?.id !== userId) {
    throw new Error("Prisma smoke could not read the created user");
  }
} finally {
  if (userId) {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.$disconnect();
}

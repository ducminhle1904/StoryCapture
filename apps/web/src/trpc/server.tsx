import "server-only";

import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { headers } from "next/headers";
import { cache } from "react";
import { createTRPCContext } from "./init";
import { makeQueryClient } from "./query-client";
import { appRouter } from "./routers/_app";
import { createCallerFactory } from "./init";

/**
 * Server-side tRPC caller for React Server Components.
 * Allows direct procedure calls without HTTP round-trip.
 */
const createCaller = createCallerFactory(appRouter);

export const caller = cache(async () => {
  const hdrs = await headers();
  return createCaller({
    prisma: (await createTRPCContext({ headers: hdrs })).prisma,
    session: null,
    user: null,
    headers: hdrs,
  });
});

export const trpc = createTRPCOptionsProxy({
  ctx: async () => {
    const hdrs = await headers();
    return createTRPCContext({ headers: hdrs });
  },
  router: appRouter,
  queryClient: makeQueryClient,
});

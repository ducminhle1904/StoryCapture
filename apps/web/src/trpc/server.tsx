import "server-only";

import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { headers } from "next/headers";
import { cache } from "react";
import { createCallerFactory, createTRPCContext } from "./init";
import { makeQueryClient } from "./query-client";
import { appRouter } from "./routers/_app";

/**
 * Server-side tRPC caller for React Server Components.
 * Allows direct procedure calls without HTTP round-trip.
 */
const createCaller = createCallerFactory(appRouter);

export const caller = cache(async () => {
  const hdrs = await headers();
  const ctx = await createTRPCContext({ headers: hdrs });
  return createCaller(ctx);
});

export const trpc = createTRPCOptionsProxy({
  ctx: async () => {
    const hdrs = await headers();
    return createTRPCContext({ headers: hdrs });
  },
  router: appRouter,
  queryClient: makeQueryClient,
});

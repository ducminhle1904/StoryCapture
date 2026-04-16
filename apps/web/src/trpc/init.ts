import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { prisma } from "@/lib/prisma";

/**
 * tRPC context — available to all procedures.
 * Session wiring comes in Plan 04-02 (auth).
 */
export async function createTRPCContext(opts: { headers: Headers }) {
  return {
    prisma,
    session: null as null, // wired in Plan 04-02
    user: null as null, // wired in Plan 04-02
    headers: opts.headers,
  };
}

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Protected procedure — placeholder that throws UNAUTHORIZED.
 * Replaced in Plan 04-02 with real auth check.
 */
export const protectedProcedure = t.procedure.use(async ({ next }) => {
  // TODO(04-02): Replace with real session check
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: "Authentication required. Wired in Plan 04-02.",
  });
});

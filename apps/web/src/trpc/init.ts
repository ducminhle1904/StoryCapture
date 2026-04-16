import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

/**
 * tRPC context — available to all procedures.
 * Includes auth session from NextAuth v5.
 */
export async function createTRPCContext(opts: { headers: Headers }) {
  const session = await auth();

  return {
    prisma,
    session,
    user: session?.user ?? null,
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
 * Protected procedure — checks auth session and throws UNAUTHORIZED if absent (T-04-05).
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
      user: ctx.session.user,
    },
  });
});

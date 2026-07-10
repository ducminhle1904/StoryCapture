import { publicProcedure, router } from "../init";

export const healthRouter = router({
  ping: publicProcedure.query(() => {
    return { ok: true as const, timestamp: new Date() };
  }),
});

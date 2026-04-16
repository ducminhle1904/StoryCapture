import { router } from "../init";
import { healthRouter } from "./health";
import { userRouter } from "./user";
import { videoRouter } from "./video";

export const appRouter = router({
  health: healthRouter,
  user: userRouter,
  video: videoRouter,
});

export type AppRouter = typeof appRouter;

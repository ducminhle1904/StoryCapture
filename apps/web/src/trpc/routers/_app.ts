import { router } from "../init";
import { analyticsRouter } from "./analytics";
import { healthRouter } from "./health";
import { templateRouter } from "./template";
import { userRouter } from "./user";
import { videoRouter } from "./video";
import { workspaceRouter } from "./workspace";

export const appRouter = router({
  analytics: analyticsRouter,
  health: healthRouter,
  template: templateRouter,
  user: userRouter,
  video: videoRouter,
  workspace: workspaceRouter,
});

export type AppRouter = typeof appRouter;

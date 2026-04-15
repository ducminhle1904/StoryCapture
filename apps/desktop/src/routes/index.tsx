import { createBrowserRouter, Navigate } from "react-router-dom";

import DashboardRoute from "./dashboard";
import EditorRoute from "./editor";
import PostProductionRoute from "./post-production";
import RecorderRoute from "./recorder";

/**
 * Phase 1 routing (UI-01, UI-02, UI-04).
 *
 * Three routes only:
 *   - `/` → dashboard (project grid)
 *   - `/editor/:projectId` → story editor + preview + timeline
 *   - `/recorder/:projectId` → recording view (TCC preflight, HUD, trail)
 *
 * No auth, no nested routes in Phase 1. Web companion (Phase 4) has its own
 * Next.js routing; these routes live only inside the Tauri webview.
 */
export const router = createBrowserRouter([
  { path: "/", element: <DashboardRoute /> },
  { path: "/editor/:projectId", element: <EditorRoute /> },
  { path: "/recorder/:projectId", element: <RecorderRoute /> },
  { path: "/post-production/:storyId", element: <PostProductionRoute /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

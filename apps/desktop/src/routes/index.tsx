import { createBrowserRouter, Navigate } from "react-router-dom";

import { AppLayout, FullscreenLayout } from "@/components/title-bar";
import DashboardRoute from "./dashboard";
import DesignSystemComponentsRoute from "./_design-system/components";
import DesignSystemTokensRoute from "./_design-system/tokens";
import EditorRoute from "./editor";
import PostProductionRoute from "./post-production";
import RecorderRoute from "./recorder";
import SettingsRoute from "./settings";
// Plan 06-02 — transparent region-selection overlay window.
import { RegionOverlay } from "@/features/capture/RegionOverlay";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <DashboardRoute /> },
      { path: "/settings", element: <SettingsRoute /> },
      // Hidden design-system showcase (D-06f); reachable by URL only, not linked.
      { path: "/_design-system/tokens", element: <DesignSystemTokensRoute /> },
      { path: "/_design-system/components", element: <DesignSystemComponentsRoute /> },
    ],
  },
  {
    element: <FullscreenLayout />,
    children: [
      { path: "/editor/:projectId", element: <EditorRoute /> },
      { path: "/recorder/:projectId", element: <RecorderRoute /> },
      { path: "/post-production/:storyId", element: <PostProductionRoute /> },
    ],
  },
  // Overlay window — no AppLayout / FullscreenLayout chrome; rendered as
  // a bare, transparent page. The Tauri window is configured with
  // transparent: true + decorations: false + fullscreen: true.
  { path: "/region-overlay", element: <RegionOverlay /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

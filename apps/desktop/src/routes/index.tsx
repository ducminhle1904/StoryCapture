import { createBrowserRouter, Navigate } from "react-router-dom";

import { AppLayout, FullscreenLayout } from "@/components/title-bar";
import DashboardRoute from "./dashboard";
import EditorRoute from "./editor";
import PostProductionRoute from "./post-production";
import PostProductionLandingRoute from "./post-production-landing";
import RecorderRoute from "./recorder";
import SettingsRoute from "./settings";
// Plan 06-02 — transparent region-selection overlay window.
import { RegionOverlay } from "@/features/capture/RegionOverlay";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <DashboardRoute /> },
      { path: "/post-production", element: <PostProductionLandingRoute /> },
      { path: "/settings", element: <SettingsRoute /> },
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

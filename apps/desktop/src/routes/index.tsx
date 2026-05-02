import { createBrowserRouter, Navigate } from "react-router-dom";

import { AppLayout, FullscreenLayout } from "@/components/title-bar";
import DashboardRoute from "./dashboard";
import EditorRoute from "./editor";
import OnboardingRoute from "./onboarding";
import PostProductionRoute from "./post-production";
import PostProductionLandingRoute from "./post-production-landing";
import RecorderRoute from "./recorder";
import SettingsRoute from "./settings";

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
      { path: "/onboarding", element: <OnboardingRoute /> },
      { path: "/editor/:projectId", element: <EditorRoute /> },
      { path: "/recorder/:projectId", element: <RecorderRoute /> },
      { path: "/post-production/:storyId", element: <PostProductionRoute /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

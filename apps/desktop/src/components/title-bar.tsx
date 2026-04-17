import { Outlet } from "react-router-dom";

import { Sidebar } from "@/components/sidebar";
import { StatusBar } from "@/components/status-bar";

/**
 * Layout with left sidebar — for top-level routes (dashboard, settings).
 */
export function AppLayout() {
  return (
    <div className="app-shell flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

/**
 * Full-width layout — for immersive workspaces (editor, recorder,
 * post-production) where every pixel is working space. Routes using this
 * layout are responsible for rendering their own back affordance in the
 * top bar.
 */
export function FullscreenLayout() {
  return (
    <div className="app-shell flex h-screen flex-col">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
      <StatusBar />
    </div>
  );
}

import { Outlet } from "react-router-dom";

import { Sidebar } from "@/components/sidebar";
import { StatusBar } from "@/components/status-bar";

export function AppLayout() {
  return (
    <div className="app-shell flex h-screen flex-col">
      {/* Title bar area — macOS drag region */}
      <div
        data-tauri-drag-region
        className="flex h-7 shrink-0 items-center bg-[var(--color-surface-300)] px-3"
      >
        {/* macOS traffic lights occupy ~70px on the left; leave space */}
        <div className="pl-[70px]" data-tauri-drag-region>
          <span
            className="text-[11px] font-medium tracking-wide text-[var(--color-fg-secondary)]"
            data-tauri-drag-region
          >
            StoryCapture
          </span>
        </div>
      </div>

      {/* Main content area: sidebar + routes */}
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="min-h-0 min-w-0 flex-1">
          <Outlet />
        </div>
      </div>

      {/* Status bar */}
      <StatusBar />
    </div>
  );
}

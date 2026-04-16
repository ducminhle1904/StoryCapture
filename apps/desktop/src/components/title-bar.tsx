import { Outlet } from "react-router-dom";

import { Sidebar } from "@/components/sidebar";
import { StatusBar } from "@/components/status-bar";

export function AppLayout() {
  return (
    <div className="app-shell flex h-screen flex-col">
      {/* Full-width drag region for macOS title bar */}
      <div
        data-tauri-drag-region
        className="h-7 shrink-0 bg-[var(--color-surface-300)]"
      />

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

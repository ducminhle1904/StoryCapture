import { Outlet } from "react-router-dom";

export function AppLayout() {
  return (
    <div className="flex h-screen flex-col">
      <div
        data-tauri-drag-region
        className="flex h-[28px] shrink-0 items-center pl-[80px] pr-3"
      >
        <span
          data-tauri-drag-region
          className="text-[11px] font-medium text-[var(--color-fg-muted)] select-none"
        >
          StoryCapture
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

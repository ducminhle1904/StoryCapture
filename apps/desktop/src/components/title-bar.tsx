import { Outlet } from "react-router-dom";

export function AppLayout() {
  return (
    <div className="app-shell flex h-screen flex-col">
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

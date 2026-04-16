"use client";

import { WorkspaceSwitcher } from "@/components/workspace-switcher";

/**
 * Client-side wrapper to render WorkspaceSwitcher in the dashboard page.
 * The dashboard page is a server component that passes the current workspace ID.
 */
export function WorkspaceSwitcherServer({
  currentWorkspaceId,
}: {
  currentWorkspaceId?: string;
}) {
  return <WorkspaceSwitcher currentWorkspaceId={currentWorkspaceId} />;
}

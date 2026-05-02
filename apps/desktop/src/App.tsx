import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import { toast } from "sonner";

import { PanicModal } from "@/components/panic-modal";
import { RecordingIndicator } from "@/components/recording-indicator";
import { router } from "@/routes";
import { checkUpdate } from "@/ipc/updater";
import { fetchProjects } from "@/ipc/projects";
import { filterAndSort } from "@/features/dashboard/project-utils";
import { useAppSettingsStore } from "@/state/app-settings";
import { useDashboardStore } from "@/state/projects";

// Sonner CSS-var skin wired to sc-* tokens. `theme="dark"` is hard-coded
// until Wave 5 introduces tweaks-store (theme selector).
const TOASTER_STYLE: CSSProperties = {
  ["--normal-bg" as string]: "var(--sc-surface)",
  ["--normal-text" as string]: "var(--sc-text)",
  ["--normal-border" as string]: "var(--sc-border-2)",
  ["--border-radius" as string]: "var(--sc-r-lg)",
  ["--toast-animation-duration" as string]: "200ms",
};

export default function App() {
  const didRunStartup = useRef(false);
  const requestNewProject = useDashboardStore((s) => s.requestNewProject);

  useEffect(() => {
    if (didRunStartup.current) return;
    didRunStartup.current = true;
    const settings = useAppSettingsStore.getState().settings;
    if (!settings) return;

    if (settings.updates.check_updates_on_launch) {
      checkUpdate()
        .then((info) => {
          if (info) {
            toast.info(`StoryCapture ${info.version} is available`, {
              description: "Open Settings → About to install the update.",
            });
          }
        })
        .catch(() => {});
    }

    if (settings.general.startup_behavior === "welcome") {
      void router.navigate("/onboarding");
      return;
    }
    if (settings.general.startup_behavior === "new_story") {
      void router.navigate("/");
      window.setTimeout(() => requestNewProject(), 0);
      return;
    }
    fetchProjects()
      .then((projects) => {
        const [latest] = filterAndSort(projects, "", "recent");
        if (latest) void router.navigate(`/editor/${latest.id}`);
      })
      .catch(() => {});
  }, [requestNewProject]);

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <PanicModal />
      <RouterProvider router={router} />
      <RecordingIndicator />
      <Toaster position="bottom-left" theme="dark" style={TOASTER_STYLE} />
    </>
  );
}

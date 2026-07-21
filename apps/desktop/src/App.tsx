import { useEffect, useRef } from "react";
import { RouterProvider } from "react-router-dom";

import { PanicModal } from "@/components/panic-modal";
import { RecordingIndicator } from "@/components/recording-indicator";
import { filterAndSort } from "@/features/dashboard/project-utils";
import { fetchProjects } from "@/ipc/projects";
import { checkUpdate } from "@/ipc/updater";
import { NotificationPresenter, notifications } from "@/lib/notifications";
import { router } from "@/routes";
import { useAppSettingsStore } from "@/state/app-settings";
import { useDashboardStore } from "@/state/projects";

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
            notifications.info(`StoryCapture ${info.version} is available`, {
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
      <NotificationPresenter />
      <RouterProvider router={router} />
      <RecordingIndicator />
    </>
  );
}

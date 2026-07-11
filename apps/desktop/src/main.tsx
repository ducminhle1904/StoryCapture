import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { ExportCompositorApp } from "./features/post-production/export-compositor/export-compositor-app";
import { PreviewPlayer } from "./features/post-production/preview/preview-player";
import { queryClient } from "./ipc/query-client";
import { frontendLog, installGlobalErrorHandlers } from "./lib/log";
import { initOutputPrefs } from "./lib/output-prefs-persist";
import { applyPersistedTheme } from "./lib/theme";
import { useAppSettingsStore } from "./state/app-settings";
import { applyCaptureFpsDefault } from "./state/output-prefs";

installGlobalErrorHandlers();
applyPersistedTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}
const root = createRoot(container);
const isExportCompositor =
  new URLSearchParams(window.location.search).get("storycaptureExportCompositor") === "1";
const previewE2EParams = new URLSearchParams(window.location.search);
const previewE2ESrc = import.meta.env.DEV ? previewE2EParams.get("storycapturePreviewE2E") : null;

async function bootstrap() {
  const [settingsResult, outputPrefsResult] = await Promise.allSettled([
    useAppSettingsStore.getState().hydrate(),
    initOutputPrefs(),
  ]);
  const settings =
    settingsResult.status === "fulfilled"
      ? settingsResult.value
      : useAppSettingsStore.getState().settings;
  if (settingsResult.status === "rejected") {
    frontendLog.error("bootstrap", "app settings init failed; rendering anyway", {
      error: settingsResult.reason,
    });
  }
  if (outputPrefsResult.status === "rejected") {
    frontendLog.error("bootstrap", "initOutputPrefs failed; rendering anyway", {
      error: outputPrefsResult.reason,
    });
  }
  if (settings) {
    applyCaptureFpsDefault(settings.capture);
  }
  root.render(
    <StrictMode>
      <ErrorBoundary source="root">
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}

if (previewE2ESrc) {
  root.render(<PreviewPlayer storyId="preview-e2e" videoSrc={previewE2ESrc} />);
} else if (isExportCompositor) {
  root.render(<ExportCompositorApp />);
} else {
  void bootstrap();
}

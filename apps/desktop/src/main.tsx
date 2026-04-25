import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { queryClient } from "./ipc/query-client";
import { frontendLog, installGlobalErrorHandlers } from "./lib/log";
import { initOutputPrefs } from "./lib/output-prefs-persist";
import { applyPersistedTheme } from "./lib/theme";

installGlobalErrorHandlers();
applyPersistedTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}
const root = createRoot(container);

async function bootstrap() {
  try {
    await initOutputPrefs();
  } catch (err) {
    frontendLog.error("bootstrap", "initOutputPrefs failed; rendering anyway", {
      error: err,
    });
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

void bootstrap();

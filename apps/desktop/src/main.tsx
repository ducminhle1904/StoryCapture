import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import App from "./App";
import { queryClient } from "./ipc/query-client";
import { initOutputPrefs } from "./lib/output-prefs-persist";
import { applyPersistedTheme } from "./lib/theme";

applyPersistedTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}
const root = createRoot(container);

async function bootstrap() {
  await initOutputPrefs();
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();

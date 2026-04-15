import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import "./styles.css";
import App from "./App";
import { queryClient } from "./ipc/query-client";
import { applyPersistedTheme } from "./lib/theme";

applyPersistedTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

import type { CSSProperties } from "react";
import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";

import { PanicModal } from "@/components/panic-modal";
import { RecordingIndicator } from "@/components/recording-indicator";
import { router } from "@/routes";

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

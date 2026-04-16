import { RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";

import { PanicModal } from "@/components/panic-modal";
import { router } from "@/routes";

export default function App() {
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <div
        data-tauri-drag-region
        aria-hidden="true"
        className="fixed inset-x-0 top-0 z-50 h-[28px] pointer-events-auto"
      />
      <PanicModal />
      <RouterProvider router={router} />
      <Toaster position="bottom-right" theme="dark" richColors />
    </>
  );
}

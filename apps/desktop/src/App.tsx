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
      <PanicModal />
      <RouterProvider router={router} />
      <Toaster position="bottom-right" theme="dark" richColors />
    </>
  );
}

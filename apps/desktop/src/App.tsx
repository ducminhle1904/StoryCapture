import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";

import { ping, appInfo } from "@/ipc";
import { PanicModal } from "@/components/panic-modal";

export default function App() {
  const { data: pong, error: pongError } = useQuery({
    queryKey: ["ping"],
    queryFn: ping,
  });
  const { data: info, error: infoError } = useQuery({
    queryKey: ["app_info"],
    queryFn: appInfo,
  });

  return (
    <motion.main
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="min-h-screen p-8"
    >
      <PanicModal />
      <header className="flex items-center gap-3">
        <Activity className="text-[var(--color-accent)]" />
        <h1 className="text-2xl font-semibold tracking-tight">StoryCapture</h1>
      </header>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Phase 1 scaffold — typed IPC + Base UI + Tailwind v4 wired.
      </p>
      <section className="mt-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--color-muted)]">
          IPC round-trip
        </h2>
        <pre className="font-mono mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
{`ping: ${pongError ? `error: ${String(pongError)}` : (pong ?? "loading…")}
app_info: ${infoError ? `error: ${String(infoError)}` : JSON.stringify(info ?? null, null, 2)}`}
        </pre>
      </section>
    </motion.main>
  );
}

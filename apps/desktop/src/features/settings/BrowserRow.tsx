import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import { AlertTriangle, FolderSearch, X } from "lucide-react";

import { getAppSettings, setBrowserExecutable } from "@/ipc/settings";

const PRESETS = [
  { label: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { label: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
  { label: "Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  { label: "Arc", path: "/Applications/Arc.app/Contents/MacOS/Arc" },
  { label: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
];

export function BrowserRow() {
  const [path, setPath] = useState<string | null>(null);
  const [pathMissing, setPathMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const checkPath = useCallback(async (p: string | null) => {
    if (!p) {
      setPathMissing(false);
      return;
    }
    try {
      setPathMissing(!(await exists(p)));
    } catch {
      setPathMissing(true);
    }
  }, []);

  useEffect(() => {
    getAppSettings()
      .then((s) => {
        setPath(s.browser_executable);
        void checkPath(s.browser_executable);
      })
      .catch(() => {});
  }, [checkPath]);

  const save = useCallback(
    async (value: string | null) => {
      setBusy(true);
      try {
        if (value) {
          let ok = false;
          try {
            ok = await exists(value);
          } catch {
            ok = false;
          }
          if (!ok) {
            toast.error("Browser not found", {
              description: `${value} doesn't exist on this machine. Install it first or pick a different browser.`,
            });
            return;
          }
        }
        const next = await setBrowserExecutable(value);
        setPath(next.browser_executable);
        await checkPath(next.browser_executable);
        toast.success(
          value ? `Using ${value.split("/").pop()}` : "Reverted to bundled Chromium",
        );
      } finally {
        setBusy(false);
      }
    },
    [checkPath],
  );

  const pick = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Select browser executable",
    });
    if (typeof selected === "string") await save(selected);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-[var(--color-fg-primary)]">
              Browser executable
            </span>
            {pathMissing && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-[var(--color-danger)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-danger)]"
                title="This path no longer exists on disk"
              >
                <AlertTriangle size={10} aria-hidden />
                Not found
              </span>
            )}
          </div>
          <div
            className={`mt-0.5 truncate text-[11px] ${
              pathMissing
                ? "text-[var(--color-danger)]"
                : "text-[var(--color-fg-muted)]"
            }`}
          >
            {path ?? "Using Playwright's bundled Chromium"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={pick}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-default)] bg-[var(--color-surface-200)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-fg-primary)] hover:bg-[var(--color-surface-300)] disabled:opacity-50"
          >
            <FolderSearch size={13} aria-hidden />
            Browse
          </button>
          {path && (
            <button
              type="button"
              onClick={() => save(null)}
              disabled={busy}
              aria-label="Clear"
              className="inline-flex items-center rounded-md border border-[var(--color-border-default)] bg-[var(--color-surface-200)] p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-300)] disabled:opacity-50"
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => save(p.path)}
            disabled={busy}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-50)] px-2 py-0.5 text-[11px] text-[var(--color-fg-secondary)] hover:border-[var(--color-border-default)] hover:text-[var(--color-fg-primary)] disabled:opacity-50"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

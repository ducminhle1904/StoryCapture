import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { open } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { AlertTriangle, FolderSearch, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { setBrowserExecutable } from "@/ipc/settings";
import { notifications } from "@/lib/notifications";
import { useAppSettingsStore } from "@/state/app-settings";

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
  const settings = useAppSettingsStore((s) => s.settings);
  const hydrate = useAppSettingsStore((s) => s.hydrate);

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
    if (settings) {
      const existing = settings.browser_executable ?? null;
      setPath(existing);
      void checkPath(existing);
      return;
    }
    hydrate()
      .then((s) => {
        setPath(s.browser_executable);
        void checkPath(s.browser_executable);
      })
      .catch(() => {});
  }, [checkPath, hydrate, settings]);

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
            notifications.error("Browser not found", {
              description: `${value} doesn't exist on this machine. Install it first or pick a different browser.`,
            });
            return;
          }
        }
        const next = await setBrowserExecutable(value);
        useAppSettingsStore.setState({ settings: next });
        setPath(next.browser_executable);
        await checkPath(next.browser_executable);
        notifications.success(
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
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-card)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-[var(--color-text-primary)]">
              Browser executable
            </span>
            {pathMissing && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-[var(--color-error)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-error)]"
                title="This path no longer exists on disk"
              >
                <AlertTriangle size={10} aria-hidden />
                Not found
              </span>
            )}
          </div>
          <div
            className={`mt-0.5 truncate text-[11px] ${
              pathMissing ? "text-[var(--color-error)]" : "text-[var(--color-text-secondary)]"
            }`}
          >
            {path ?? "Using Playwright's bundled Chromium"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <AstryxButton
            variant="secondary"
            size="sm"
            onClick={pick}
            isDisabled={busy}
            label="Browse for browser executable"
            icon={<FolderSearch size={13} aria-hidden />}
          >
            Browse
          </AstryxButton>
          {path && (
            <AstryxButton
              variant="ghost"
              size="sm"
              onClick={() => save(null)}
              isDisabled={busy}
              label="Clear browser executable"
              isIconOnly
              icon={<X size={13} aria-hidden />}
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {PRESETS.map((p) => (
          <AstryxButton
            key={p.label}
            variant="ghost"
            size="sm"
            onClick={() => save(p.path)}
            isDisabled={busy}
            label={`Use ${p.label}`}
          >
            {p.label}
          </AstryxButton>
        ))}
      </div>
    </div>
  );
}

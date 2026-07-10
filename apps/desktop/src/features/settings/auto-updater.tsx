import { AlertTriangle, CheckCircle2, Download, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { checkUpdate, installUpdate, type UpdateInfo } from "@/ipc/updater";
import { useAppSettingsStore } from "@/state/app-settings";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; update: UpdateInfo }
  | { kind: "error"; message: string }
  | { kind: "installing" };

export function AutoUpdaterSettings() {
  const [checkState, setCheckState] = useState<CheckState>({ kind: "idle" });
  const settings = useAppSettingsStore((s) => s.settings);
  const hydrate = useAppSettingsStore((s) => s.hydrate);
  const patchUpdates = useAppSettingsStore((s) => s.patchUpdates);
  const checkOnLaunch = settings?.updates.check_updates_on_launch ?? false;

  useEffect(() => {
    hydrate()
      .then((next) => {
        if (next.updates.check_updates_on_launch) return;
        try {
          if (window.localStorage.getItem("storycapture.updater.check-on-launch") === "true") {
            void patchUpdates({ check_updates_on_launch: true });
            window.localStorage.removeItem("storycapture.updater.check-on-launch");
          }
        } catch {}
      })
      .catch(() => {});
  }, [hydrate, patchUpdates]);

  const onToggle = useCallback(
    async (next: boolean) => {
      if (!settings) await hydrate();
      await patchUpdates({ check_updates_on_launch: next });
    },
    [hydrate, patchUpdates, settings],
  );

  const runCheck = useCallback(async () => {
    setCheckState({ kind: "checking" });
    try {
      const info = await checkUpdate();
      if (info) setCheckState({ kind: "available", update: info });
      else setCheckState({ kind: "up-to-date" });
    } catch (e) {
      setCheckState({ kind: "error", message: String(e) });
    }
  }, []);

  const runInstall = useCallback(async () => {
    setCheckState({ kind: "installing" });
    try {
      await installUpdate();
      setCheckState({ kind: "idle" });
    } catch (e) {
      setCheckState({ kind: "error", message: String(e) });
    }
  }, []);

  return (
    <section aria-labelledby="auto-updater-heading" className="space-y-4">
      {/* Toggle */}
      <label
        htmlFor="check-on-launch"
        className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-4 py-3 transition-colors hover:bg-[var(--color-surface-200)]"
      >
        <input
          id="check-on-launch"
          type="checkbox"
          checked={checkOnLaunch}
          onChange={(e) => void onToggle(e.target.checked)}
          className="h-4 w-4 rounded accent-[var(--color-accent-primary)]"
        />
        <div>
          <div className="text-sm font-medium text-[var(--color-fg-primary)]">Check on launch</div>
          <div className="text-xs text-[var(--color-fg-muted)]">
            {checkOnLaunch
              ? "The app will check when it starts."
              : "No network calls until you press check."}
          </div>
        </div>
      </label>

      {/* Check button + status */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={checkState.kind === "checking" || checkState.kind === "installing"}
          className="inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-2 text-sm text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-surface-200)] disabled:opacity-50"
        >
          <RefreshCcw
            size={13}
            aria-hidden="true"
            className={checkState.kind === "checking" ? "animate-spin" : undefined}
          />
          Check now
        </button>

        {checkState.kind === "up-to-date" && (
          <span className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
            <CheckCircle2 size={13} aria-hidden="true" />
            Up to date
          </span>
        )}
        {checkState.kind === "error" && (
          <span role="alert" className="flex items-center gap-1 text-xs text-[var(--color-danger)]">
            <AlertTriangle size={13} aria-hidden="true" />
            {checkState.message}
          </span>
        )}
      </div>

      {/* Update available */}
      {checkState.kind === "available" && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-accent-primary)]/30 bg-[var(--color-accent-primary)]/6 p-4">
          <div className="text-sm font-medium text-[var(--color-fg-primary)]">
            {checkState.update.current_version} &rarr; {checkState.update.version}
          </div>
          {checkState.update.date && (
            <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Released {checkState.update.date}
            </div>
          )}
          {checkState.update.body && (
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-100)] p-3 text-xs text-[var(--color-fg-secondary)]">
              {checkState.update.body}
            </pre>
          )}
          <button
            type="button"
            onClick={() => void runInstall()}
            className="brand-button mt-3 inline-flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium text-[var(--color-fg-primary)]"
          >
            <Download size={13} aria-hidden="true" />
            Download and install
          </button>
        </div>
      )}

      {checkState.kind === "installing" && (
        <div role="status" className="text-xs text-[var(--color-fg-muted)]">
          Downloading — the app will relaunch when ready.
        </div>
      )}
    </section>
  );
}

export default AutoUpdaterSettings;

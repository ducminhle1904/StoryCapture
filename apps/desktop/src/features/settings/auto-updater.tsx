import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Switch } from "@astryxdesign/core/Switch";
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
    <div className="space-y-4">
      {/* Toggle */}
      <Switch
        label="Check on launch"
        description={
          checkOnLaunch
            ? "The app will check when it starts."
            : "No network calls until you press check."
        }
        value={checkOnLaunch}
        onChange={(next) => void onToggle(next)}
      />

      {/* Check button + status */}
      <div className="flex items-center gap-3">
        <AstryxButton
          variant="secondary"
          onClick={() => void runCheck()}
          isDisabled={checkState.kind === "checking" || checkState.kind === "installing"}
          label="Check now"
          icon={
            <RefreshCcw
              size={13}
              aria-hidden="true"
              className={checkState.kind === "checking" ? "animate-spin" : undefined}
            />
          }
        >
          Check now
        </AstryxButton>

        {checkState.kind === "up-to-date" && (
          <span className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
            <CheckCircle2 size={13} aria-hidden="true" />
            Up to date
          </span>
        )}
        {checkState.kind === "error" && (
          <span role="alert" className="flex items-center gap-1 text-xs text-[var(--color-error)]">
            <AlertTriangle size={13} aria-hidden="true" />
            {checkState.message}
          </span>
        )}
      </div>

      {/* Update available */}
      {checkState.kind === "available" && (
        <div className="rounded-[var(--radius-container)] border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/6 p-4">
          <div className="text-sm font-medium text-[var(--color-text-primary)]">
            {checkState.update.current_version} &rarr; {checkState.update.version}
          </div>
          {checkState.update.date && (
            <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
              Released {checkState.update.date}
            </div>
          )}
          {checkState.update.body && (
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-[var(--radius-element)] bg-[var(--color-background-card)] p-3 text-xs text-[var(--color-text-secondary)]">
              {checkState.update.body}
            </pre>
          )}
          <AstryxButton
            variant="primary"
            onClick={() => void runInstall()}
            label="Download and install"
            icon={<Download size={13} aria-hidden="true" />}
            className="mt-3"
          >
            Download and install
          </AstryxButton>
        </div>
      )}

      {checkState.kind === "installing" && (
        <div role="status" className="text-xs text-[var(--color-text-secondary)]">
          Downloading — the app will relaunch when ready.
        </div>
      )}
    </div>
  );
}

export default AutoUpdaterSettings;

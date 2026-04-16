/**
 * Auto-updater settings panel (DIST-03, DIST-05).
 *
 * - Toggle: "Check for updates on launch" — defaults OFF. Persisted via
 *   @tauri-apps/plugin-store under the key `updater.check-on-launch`.
 * - "Check now" → invokes the `check_update` command.
 * - Release-notes + Install button appear only when an update is available.
 *
 * This component never triggers an update check on its own mount; the
 * caller (a future onboarding/launch hook) is responsible for reading the
 * preference and, if true, calling `checkUpdate()` once at startup. Default
 * is OFF per the telemetry-off constraint.
 */

import { useEffect, useState, useCallback } from "react";
import { Download, RefreshCcw, CheckCircle2, AlertTriangle } from "lucide-react";

import { checkUpdate, installUpdate, type UpdateInfo } from "@/ipc/updater";

const PREF_KEY = "storycapture.updater.check-on-launch";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; update: UpdateInfo }
  | { kind: "error"; message: string }
  | { kind: "installing" };

// The Phase-1 host does not yet expose `tauri-plugin-store`; persist the
// opt-in through the webview's localStorage instead. A future plan can
// migrate to the store plugin without changing this component's shape.
function loadPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === "true";
  } catch {
    return false;
  }
}
function savePref(v: boolean) {
  try {
    window.localStorage.setItem(PREF_KEY, v ? "true" : "false");
  } catch {
    // swallow — UI state is still consistent for this session.
  }
}

export function AutoUpdaterSettings() {
  const [checkOnLaunch, setCheckOnLaunch] = useState<boolean>(false);
  const [checkState, setCheckState] = useState<CheckState>({ kind: "idle" });

  // Load the persisted toggle; default OFF (DIST-05).
  useEffect(() => {
    setCheckOnLaunch(loadPref());
  }, []);

  const onToggle = useCallback((next: boolean) => {
    setCheckOnLaunch(next);
    savePref(next);
  }, []);

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
      // If this call returns, the relaunch didn't take effect; show idle.
      setCheckState({ kind: "idle" });
    } catch (e) {
      setCheckState({ kind: "error", message: String(e) });
    }
  }, []);

  return (
    <section
      aria-labelledby="auto-updater-heading"
      className="brand-panel rounded-[28px] p-6"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div>
      <h2
        id="auto-updater-heading"
        className="text-lg font-semibold text-[var(--color-fg-primary)]"
      >
        Updates
      </h2>
      <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
        StoryCapture never checks for updates unless you turn this on. No
        telemetry, no background pings.
      </p>
        </div>
        <div className="rounded-[24px] border border-white/8 bg-black/14 px-4 py-4">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
            Update mode
          </div>
          <div className="mt-2 text-sm font-medium text-[var(--color-fg-primary)]">
            {checkOnLaunch ? "Check on launch" : "Manual only"}
          </div>
          <div className="mt-2 text-xs leading-5 text-[var(--color-fg-muted)]">
            {checkOnLaunch
              ? "The app will check for a new build when it starts."
              : "No network call happens until you press check."}
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3 rounded-[24px] border border-white/8 bg-black/14 px-4 py-4">
        <input
          id="check-on-launch"
          type="checkbox"
          checked={checkOnLaunch}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 accent-[var(--color-accent-primary)]"
        />
        <label htmlFor="check-on-launch" className="text-sm">
          Check for updates on launch
        </label>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={checkState.kind === "checking" || checkState.kind === "installing"}
          className="inline-flex items-center gap-2 rounded-xl border border-white/8 bg-white/4 px-4 py-2.5 text-sm text-[var(--color-fg-primary)] hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] disabled:opacity-50"
        >
          <RefreshCcw
            size={14}
            aria-hidden="true"
            className={checkState.kind === "checking" ? "animate-spin" : undefined}
          />
          Check now
        </button>

        {checkState.kind === "up-to-date" && (
          <span className="inline-flex items-center gap-1 text-sm text-[var(--color-fg-muted)]">
            <CheckCircle2 size={14} aria-hidden="true" />
            Up to date.
          </span>
        )}
        {checkState.kind === "error" && (
          <span
            role="alert"
            className="inline-flex items-center gap-1 text-sm text-[var(--color-danger)]"
          >
            <AlertTriangle size={14} aria-hidden="true" />
            {checkState.message}
          </span>
        )}
      </div>

      {checkState.kind === "available" && (
        <div className="mt-5 rounded-[24px] border border-[var(--color-accent-primary)]/30 bg-[var(--color-accent-primary)]/8 p-4">
          <div className="text-sm font-medium text-[var(--color-fg-primary)]">
            Update available: {checkState.update.current_version} →{" "}
            {checkState.update.version}
          </div>
          {checkState.update.date && (
            <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
              Released {checkState.update.date}
            </div>
          )}
          {checkState.update.body && (
            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-sunken)] p-3 text-xs text-[var(--color-fg-muted)]">
              {checkState.update.body}
            </pre>
          )}
          <button
            type="button"
            onClick={() => void runInstall()}
            className="brand-button mt-4 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <Download size={14} aria-hidden="true" />
            Download &amp; install
          </button>
        </div>
      )}

      {checkState.kind === "installing" && (
        <div
          role="status"
          className="mt-5 text-sm text-[var(--color-fg-muted)]"
        >
          Downloading and installing update — the app will relaunch when done.
        </div>
      )}
    </section>
  );
}

export default AutoUpdaterSettings;

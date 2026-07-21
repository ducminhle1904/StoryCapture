/**
 * TCC / Screen Recording permission UX.
 *
 * Three-step guided modal on macOS:
 *  1. "Open System Settings" → `open_screen_capture_prefs()`
 *  2. "I've granted, Reopen" → `relaunch_app()`
 *  3. Permission granted → dismisses (handled by caller re-polling).
 *
 * On Windows + Linux the preflight check returns Granted immediately so
 * this component never renders.
 */

import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { RefreshCw, Settings, ShieldAlert } from "lucide-react";

import { openScreenCapturePrefs, type PermissionState, relaunchApp } from "@/ipc/capture";

interface TccPromptProps {
  open: boolean;
  permission: PermissionState;
  appName: string;
  onDismiss: () => void;
}

export function TccPrompt({ open, permission, appName, onDismiss }: TccPromptProps) {
  if (permission === "granted") return null;

  return (
    <Dialog
      isOpen={open}
      onOpenChange={(nextOpen) => !nextOpen && onDismiss()}
      purpose="form"
      width={512}
      padding={6}
      aria-labelledby="tcc-prompt-title"
      aria-describedby="tcc-prompt-description"
    >
      <div>
        <div className="flex items-start gap-3">
          <div className="grid size-11 place-items-center rounded-full bg-[var(--color-warning)]/15 text-[var(--color-warning)]">
            <ShieldAlert size={20} aria-hidden="true" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-[var(--color-text-secondary)]">
              macOS permission
            </div>
            <h2
              id="tcc-prompt-title"
              className="mt-2 text-lg font-semibold text-[var(--color-text-primary)]"
            >
              Screen Recording permission needed
            </h2>
            <p
              id="tcc-prompt-description"
              className="font-serif mt-2 text-sm leading-6 text-[var(--color-text-secondary)]"
            >
              {appName} needs macOS Screen Recording access to record your browser demos. You only
              have to grant it once — the app will relaunch so the new permission takes effect.
            </p>
          </div>
        </div>

        <ol className="mt-6 flex flex-col gap-3 text-sm text-[var(--color-text-secondary)]">
          <li className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background-muted)] px-4 py-3">
            1. Open <strong>System Settings → Privacy & Security → Screen Recording</strong>.
          </li>
          <li className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background-muted)] px-4 py-3">
            2. Enable <strong>{appName}</strong>.
          </li>
          <li className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background-muted)] px-4 py-3">
            3. Relaunch the app.
          </li>
        </ol>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            label="Open System Settings"
            variant="secondary"
            icon={<Settings size={14} aria-hidden="true" />}
            onClick={() => openScreenCapturePrefs().catch(() => {})}
          />
          <Button
            label="Reopen"
            variant="primary"
            icon={<RefreshCw size={14} aria-hidden="true" />}
            onClick={() => relaunchApp().catch(() => {})}
          />
        </div>
      </div>
    </Dialog>
  );
}

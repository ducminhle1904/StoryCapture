/**
 * TCC / Screen Recording permission UX (UI-04, D-20).
 *
 * Three-step guided modal on macOS:
 *  1. "Open System Settings" → `open_screen_capture_prefs()`
 *  2. "I've granted, Reopen" → `relaunch_app()`
 *  3. Permission granted → dismisses (handled by caller re-polling).
 *
 * On Windows + Linux the preflight check returns Granted immediately so
 * this component never renders.
 */

import { Dialog } from "@base-ui-components/react/dialog";
import { ShieldAlert, Settings, RefreshCw } from "lucide-react";

import {
  openScreenCapturePrefs,
  relaunchApp,
  type PermissionState,
} from "@/ipc/capture";

interface TccPromptProps {
  open: boolean;
  permission: PermissionState;
  onDismiss: () => void;
}

export function TccPrompt({ open, permission, onDismiss }: TccPromptProps) {
  if (permission === "Granted") return null;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onDismiss()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-6 shadow-2xl">
          <div className="flex items-start gap-3">
            <div className="grid size-10 place-items-center rounded-full bg-[var(--color-warning)]/15 text-[var(--color-warning)]">
              <ShieldAlert size={20} aria-hidden="true" />
            </div>
            <div>
              <Dialog.Title className="text-base font-semibold text-[var(--color-fg-primary)]">
                Screen Recording permission needed
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-[var(--color-fg-secondary)]">
                StoryCapture needs macOS Screen Recording access to record your
                browser demos. You only have to grant it once — the app will
                relaunch so the new permission takes effect.
              </Dialog.Description>
            </div>
          </div>

          <ol className="mt-5 flex flex-col gap-3 text-sm text-[var(--color-fg-secondary)]">
            <li>
              1. Open <strong>System Settings → Privacy & Security → Screen Recording</strong>.
            </li>
            <li>
              2. Enable <strong>StoryCapture</strong>.
            </li>
            <li>3. Relaunch the app.</li>
          </ol>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => openScreenCapturePrefs().catch(() => {})}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-4 py-2 text-sm text-[var(--color-fg-primary)] hover:bg-[var(--color-bg-surface)] focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <Settings size={14} aria-hidden="true" />
              Open System Settings
            </button>
            <button
              type="button"
              onClick={() => relaunchApp().catch(() => {})}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--color-accent-primary)] px-4 py-2 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <RefreshCw size={14} aria-hidden="true" />
              Reopen
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

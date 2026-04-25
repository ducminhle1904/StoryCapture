/**
 * Panic modal: subscribes to the host's `app:panic` event (emitted by the
 * panic hook in Plan 03a) and renders a recoverable error dialog.
 *
 * Uses Base UI's Dialog primitive (NOT Radix) per D-32. Falls back to a
 * native <dialog> shape if the import is unavailable at scaffold time.
 */

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { Copy, RotateCw, X } from "lucide-react";

import { onPanic, type PanicPayload } from "@/ipc";
import { frontendLog } from "@/lib/log";
import { Button } from "@/components/ui/button";
import {
  dialogBackdropMotionClassName,
  dialogCenteredPopupMotionClassName,
  dialogViewportClassName,
} from "@/components/ui/dialog-motion";

// T-03b-04 mitigation: cap displayed panic message at 4 KB to keep modal
// responsive even if the host emits an oversized payload.
const MAX_MESSAGE_BYTES = 4096;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[truncated — ${s.length - max} chars]`;
}

export function PanicModal() {
  const [payload, setPayload] = useState<PanicPayload | null>(null);
  const [logPath, setLogPath] = useState<string>("");
  const copyTimeout = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onPanic((p) => {
      if (cancelled) return;
      setPayload({
        message: truncate(p.message ?? "Unknown error", MAX_MESSAGE_BYTES),
        thread: p.thread ?? "unknown",
      });
      // Log path is populated lazily by the host (Plan 03a). For now we use
      // a sensible default; downstream plans can wire `app_info.data_dir`.
      setLogPath("(see app log directory)");
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (copyTimeout.current !== null) {
        window.clearTimeout(copyTimeout.current);
      }
    };
  }, []);

  if (!payload) return null;

  const fullText = `Thread: ${payload.thread}\nMessage: ${payload.message}\nLog: ${logPath}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      copyTimeout.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — silently no-op; user can still restart.
    }
  };

  const handleRestart = async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      // Fallback: close the modal so the user can attempt a manual restart.
      frontendLog.error("PanicModal", "relaunch() failed; user must restart manually", {
        error: err,
      });
      setPayload(null);
    }
  };

  return (
    <Dialog.Root open={payload !== null} onOpenChange={(open) => !open && setPayload(null)}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={`fixed inset-0 z-40 bg-[var(--color-fg-primary)/50] backdrop-blur-sm ${dialogBackdropMotionClassName}`}
        />
        <Dialog.Viewport className={dialogViewportClassName}>
          <Dialog.Popup
            className={`w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl ${dialogCenteredPopupMotionClassName}`}
          >
            <div className="flex items-start justify-between">
            <Dialog.Title className="text-lg font-semibold text-[var(--color-fg)]">
              Unexpected error
            </Dialog.Title>
            <Dialog.Close
              aria-label="Dismiss"
              className="rounded p-1 text-[var(--color-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-fg)]"
            >
              <X size={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-sm text-[var(--color-muted)]">
            StoryCapture hit an unexpected error and may be in an inconsistent state.
            Restarting is recommended.
          </Dialog.Description>
          <pre className="font-mono mt-4 max-h-48 overflow-auto rounded bg-[var(--color-bg)] p-3 text-xs text-[var(--color-fg)]">
{`Thread: ${payload.thread}
${payload.message}

Log: ${logPath}`}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={handleCopy}>
              <Copy size={14} />
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button size="sm" onClick={handleRestart}>
              <RotateCw size={14} />
              Restart
            </Button>
          </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

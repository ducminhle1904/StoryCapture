/**
 * Panic modal: subscribes to the host's `app:panic` event and renders a
 * recoverable error dialog using Astryx.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Copy, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { onPanic, type PanicPayload } from "@/ipc";
import { frontendLog } from "@/lib/log";

// Cap displayed panic message at 4 KB to keep modal responsive even if
// the host emits an oversized payload.
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
      // Log path is populated lazily by the host. For now we use a
      // sensible default; future work can wire `app_info.data_dir`.
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
    <Dialog
      isOpen={payload !== null}
      onOpenChange={(open) => !open && setPayload(null)}
      purpose="info"
      width={448}
      padding={6}
      aria-labelledby="panic-modal-title"
      aria-describedby="panic-modal-description"
    >
      <div>
        <div className="flex items-start justify-between">
          <h2
            id="panic-modal-title"
            className="text-lg font-semibold text-[var(--color-text-primary)]"
          >
            Unexpected error
          </h2>
          <AstryxButton
            label="Dismiss"
            icon={<X size={16} />}
            isIconOnly
            variant="ghost"
            size="sm"
            onClick={() => setPayload(null)}
          />
        </div>
        <p id="panic-modal-description" className="mt-2 text-sm text-[var(--color-text-secondary)]">
          StoryCapture hit an unexpected error and may be in an inconsistent state. Restarting is
          recommended.
        </p>
        <pre className="font-mono mt-4 max-h-48 overflow-auto rounded bg-[var(--color-background-muted)] p-3 text-xs text-[var(--color-text-primary)]">
          {`Thread: ${payload.thread}
${payload.message}

Log: ${logPath}`}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <AstryxButton
            variant="secondary"
            size="sm"
            onClick={handleCopy}
            label="Copy error details"
          >
            <Copy size={14} />
            {copied ? "Copied" : "Copy"}
          </AstryxButton>
          <AstryxButton size="sm" onClick={handleRestart} label="Restart">
            <RotateCw size={14} />
            Restart
          </AstryxButton>
        </div>
      </div>
    </Dialog>
  );
}

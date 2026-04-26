/**
 * Cost warning modal.
 *
 * AlertDialog displayed when estimated input > 50K tokens.
 * Returns a promise resolving to {proceed, suppressForSession}.
 * The suppressForSession flag is held in a Zustand session-scoped store.
 */

import { useState, useCallback, useEffect } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { Button } from "@/components/ui/button";
import {
  dialogBackdropMotionClassName,
  dialogCenteredPopupMotionClassName,
  dialogViewportClassName,
} from "@/components/ui/dialog-motion";

export interface CostWarningResult {
  proceed: boolean;
  suppressForSession: boolean;
}

export interface CostWarningModalProps {
  estimatedTokens: number;
  open: boolean;
  suppressed?: boolean;
  onResult: (result: CostWarningResult) => void;
}

export function CostWarningModal({
  estimatedTokens,
  open,
  suppressed = false,
  onResult,
}: CostWarningModalProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // If suppressed, auto-proceed without rendering
  useEffect(() => {
    if (open && suppressed) {
      onResult({ proceed: true, suppressForSession: true });
    }
  }, [open, suppressed, onResult]);

  const handleProceed = useCallback(() => {
    onResult({ proceed: true, suppressForSession: dontAskAgain });
  }, [onResult, dontAskAgain]);

  const handleCancel = useCallback(() => {
    onResult({ proceed: false, suppressForSession: false });
  }, [onResult]);

  // Don't render if suppressed or not open
  if (!open || suppressed) {
    return null;
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => !nextOpen && handleCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={`fixed inset-0 z-50 bg-[var(--color-fg-primary)/50] backdrop-blur-sm ${dialogBackdropMotionClassName}`}
        />
        <Dialog.Viewport className={dialogViewportClassName}>
          <Dialog.Popup
            className={`w-full max-w-md rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-6 shadow-2xl ${dialogCenteredPopupMotionClassName}`}
          >
            <Dialog.Title className="text-lg font-semibold text-[var(--color-fg-primary)]">
            {"This prompt uses a lot of tokens"}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--color-fg-muted)]">
            {`This prompt is estimated to use about ${estimatedTokens.toLocaleString()} tokens. Cost may be higher than usual.`}
          </Dialog.Description>

          <label className="mt-5 flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/60 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="rounded border-[var(--color-border-subtle)]"
            />
            <span>{"Don't ask again for this session"}</span>
          </label>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={handleCancel}>
              {"Cancel"}
            </Button>
            <Button onClick={handleProceed}>
              {"Continue"}
            </Button>
          </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

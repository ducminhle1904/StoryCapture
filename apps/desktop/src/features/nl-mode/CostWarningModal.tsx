/**
 * Cost warning modal (Plan 03-20, Task 2 / AI-SPEC G7).
 *
 * AlertDialog displayed when estimated input > 50K tokens.
 * Heading: "Prompt nay dung nhieu token"
 * Checkbox: "Dung hoi lai cho session nay" -- persisted via Zustand session-scoped flag.
 * Returns promise resolving to {proceed: boolean, suppressForSession: boolean}.
 *
 * Used by Plan-07 nl_chat_send path: before invocation, estimate input tokens
 * (simple char-count / 4 heuristic), if > 50K call this modal.
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
            {"Prompt n\u00e0y d\u00f9ng nhi\u1ec1u token"}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-[var(--color-fg-muted)]">
            {`\u01af\u1edbc t\u00ednh prompt n\u00e0y s\u1eed d\u1ee5ng kho\u1ea3ng ${estimatedTokens.toLocaleString()} token. Chi ph\u00ed c\u00f3 th\u1ec3 cao h\u01a1n b\u00ecnh th\u01b0\u1eddng.`}
          </Dialog.Description>

          <label className="mt-5 flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)]/60 px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="rounded border-[var(--color-border-subtle)]"
            />
            <span>{"Đừng hỏi lại cho session này"}</span>
          </label>

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={handleCancel}>
              {"Hu\u1ef7"}
            </Button>
            <Button onClick={handleProceed}>
              {"Ti\u1ebfp t\u1ee5c"}
            </Button>
          </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

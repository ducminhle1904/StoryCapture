/**
 * Cost warning modal.
 *
 * AlertDialog displayed when estimated input > 50K tokens.
 * Returns a promise resolving to {proceed, suppressForSession}.
 * The suppressForSession flag is held in a Zustand session-scoped store.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Switch } from "@astryxdesign/core/Switch";
import { useCallback, useEffect, useState } from "react";

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
    <Dialog
      isOpen={open}
      onOpenChange={(nextOpen) => !nextOpen && handleCancel()}
      purpose="form"
      width={448}
      padding={6}
      aria-labelledby="cost-warning-title"
      aria-describedby="cost-warning-description"
    >
      <div>
        <h2
          id="cost-warning-title"
          className="text-lg font-semibold text-[var(--color-text-primary)]"
        >
          {"This prompt uses a lot of tokens"}
        </h2>
        <p
          id="cost-warning-description"
          className="mt-2 text-sm text-[var(--color-text-secondary)]"
        >
          {`This prompt is estimated to use about ${estimatedTokens.toLocaleString()} tokens. Cost may be higher than usual.`}
        </p>

        <div className="mt-5">
          <Switch
            label="Don't ask again for this session"
            value={dontAskAgain}
            onChange={setDontAskAgain}
          />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <AstryxButton variant="ghost" onClick={handleCancel} label="Cancel">
            {"Cancel"}
          </AstryxButton>
          <AstryxButton variant="primary" onClick={handleProceed} label="Continue">
            {"Continue"}
          </AstryxButton>
        </div>
      </div>
    </Dialog>
  );
}

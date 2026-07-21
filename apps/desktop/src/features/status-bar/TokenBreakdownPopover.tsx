/** Token breakdown popover. */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TurnMetric {
  turn_id: string;
  timestamp: number;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface TokenBreakdownPopoverProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
  className?: string;
}

export function TokenBreakdownPopover({ onClose, className }: TokenBreakdownPopoverProps) {
  // TODO: Wire this to the session metrics command.

  return (
    <div
      data-testid="token-breakdown-popover"
      className={cn(
        "absolute right-0 top-full z-50 mt-1 w-[400px] rounded-lg border border-[var(--color-border)] bg-[var(--color-background-body)] p-3 shadow-lg",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{"Chi ti\u1ebft token"}</h3>
        <AstryxButton
          variant="ghost"
          size="sm"
          onClick={onClose}
          label={"\u0110\u00f3ng"}
          isIconOnly
          icon={<X size={14} aria-hidden="true" />}
        />
      </div>

      <div className="max-h-[300px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-secondary)]">
              <th className="pb-1 pr-2">Turn</th>
              <th className="pb-1 pr-2">Provider</th>
              <th className="pb-1 pr-2 text-right">Input</th>
              <th className="pb-1 pr-2 text-right">Output</th>
              <th className="pb-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={5} className="py-4 text-center text-[var(--color-text-secondary)]">
                {"Ch\u01b0a c\u00f3 d\u1eef li\u1ec7u"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

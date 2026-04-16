/**
 * Token breakdown popover.
 *
 * Popover showing last 20 turns: time, provider/model, input/output/cache tokens, cost.
 * data-testid="token-breakdown-popover"
 */

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

export function TokenBreakdownPopover({
  onClose,
  className,
}: TokenBreakdownPopoverProps) {
  // TODO: Wire to Tauri command that queries llm_turn_metrics for this session
  // For now, renders the popover shell with empty state

  return (
    <div
      data-testid="token-breakdown-popover"
      className={cn(
        "absolute right-0 top-full z-50 mt-1 w-[400px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 shadow-lg",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{"Chi ti\u1ebft token"}</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          aria-label={"\u0110\u00f3ng"}
        >
          {"\u2715"}
        </button>
      </div>

      <div className="max-h-[300px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-fg-muted)]">
              <th className="pb-1 pr-2">Turn</th>
              <th className="pb-1 pr-2">Provider</th>
              <th className="pb-1 pr-2 text-right">Input</th>
              <th className="pb-1 pr-2 text-right">Output</th>
              <th className="pb-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td
                colSpan={5}
                className="py-4 text-center text-[var(--color-fg-muted)]"
              >
                {"Ch\u01b0a c\u00f3 d\u1eef li\u1ec7u"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

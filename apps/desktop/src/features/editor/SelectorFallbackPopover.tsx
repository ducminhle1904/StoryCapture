/**
 * Selector fallback popover. Triggered from the editor gutter warning
 * icon (LSP selector-fallback warning).
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { SelectorAttempt } from "./dryRunStore";

export interface SelectorFallbackPopoverProps {
  fallbackChain: SelectorAttempt[];
  onUpdateSelector?: () => void;
  className?: string;
}

export function SelectorFallbackPopover({
  fallbackChain,
  onUpdateSelector,
  className,
}: SelectorFallbackPopoverProps) {
  const winner = fallbackChain.find((a) => a.succeeded);
  const winnerIndex = winner ? fallbackChain.indexOf(winner) + 1 : null;

  return (
    <div
      data-testid="selector-fallback-popover"
      role="tooltip"
      className={`rounded-lg border border-[var(--color-border,#242733)] bg-[var(--color-background-card,#13151C)] p-3 shadow-lg max-w-xs ${className ?? ""}`}
    >
      <p className="text-sm text-[var(--color-text-primary,#E6E8EE)] mb-2">
        {"Selector qu\u00e1 chung \u2014 c\u00e2n nh\u1eafc th\u00eam fallback."}
      </p>

      {winner && winnerIndex != null && (
        <p className="text-xs text-[var(--color-text-secondary,#8A90A2)] mb-3 font-[family-name:var(--font-family-code,'JetBrains_Mono')]">
          {`L\u1ea7n ch\u1ea1y g\u1ea7n nh\u1ea5t: strategy ${winnerIndex} th\u1eafng trong ${winner.durationMs}ms.`}
        </p>
      )}

      {fallbackChain.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {fallbackChain.map((attempt, idx) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: Attempts can repeat and these stateless chips preserve execution order.
              key={`${attempt.strategy}-${idx}`}
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                attempt.succeeded
                  ? "bg-[var(--color-success,#30A46C)]/20 text-[var(--color-success,#30A46C)]"
                  : "bg-[var(--color-text-secondary,#8A90A2)]/20 text-[var(--color-text-secondary,#8A90A2)]"
              }`}
            >
              {attempt.strategy}: {attempt.durationMs}ms
            </span>
          ))}
        </div>
      )}

      <AstryxButton
        size="sm"
        variant="secondary"
        onClick={onUpdateSelector}
        className="w-full"
        label="Cập nhật selector"
      >
        {`C\u1eadp nh\u1eadt selector`}
      </AstryxButton>
    </div>
  );
}

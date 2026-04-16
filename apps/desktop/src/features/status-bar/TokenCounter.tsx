/**
 * Status-bar token counter.
 *
 * Reads session_id from app state; polls session_get_rollup via TanStack Query
 * with refetchInterval: 500 (AI-SPEC section 7.2).
 *
 * Renders ${cost.toFixed(2)} in JetBrains Mono 600 12px with tabular lining.
 * Color: idle=muted, warning if cost > $1.00, error if fetch fails.
 *
 * data-testid="token-counter"
 */

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { TokenBreakdownPopover } from "./TokenBreakdownPopover";

export interface SessionRollup {
  turn_count: number;
  total_cost_usd: number;
  total_tokens: number;
  avg_first_token_ms: number | null;
}

export interface TokenCounterProps {
  sessionId: string;
  projectId: string;
  className?: string;
}

export function TokenCounter({
  sessionId,
  projectId,
  className,
}: TokenCounterProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);

  const { data, isError } = useQuery<SessionRollup>({
    queryKey: ["session_rollup", projectId, sessionId],
    queryFn: () =>
      invoke<SessionRollup>("session_get_rollup", {
        projectId,
      }),
    refetchInterval: 500,
  });

  const cost = data?.total_cost_usd ?? 0;
  const tokens = data?.total_tokens ?? 0;
  const isWarning = cost > 1.0;

  const handleClick = useCallback(() => {
    setPopoverOpen((prev) => !prev);
  }, []);

  return (
    <div className={cn("relative inline-flex", className)}>
      <button
        data-testid="token-counter"
        type="button"
        onClick={handleClick}
        className={cn(
          "inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs font-semibold tabular-nums transition-colors",
          isError && "text-red-500",
          isWarning && !isError && "text-amber-500 bg-amber-50 warning",
          !isWarning && !isError && "text-[var(--color-fg-muted)]",
        )}
        aria-label={`Chi ti\u00eau session: $${cost.toFixed(2)}, ${tokens} token. Nh\u1ea5n \u0111\u1ec3 xem chi ti\u1ebft`}
      >
        <span>${cost.toFixed(2)}</span>
      </button>

      {popoverOpen && (
        <TokenBreakdownPopover
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </div>
  );
}

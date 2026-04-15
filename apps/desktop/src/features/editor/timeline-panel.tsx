/**
 * Timeline panel — visualizes scenes + steps from the parsed AST (UI-03).
 *
 * Duration heuristic (Phase 1): `wait <ms>` → X ms, everything else 1500 ms.
 */

import { useEditorStore } from "@/state/editor";
import type { Command } from "@/ipc/parse";

const DEFAULT_STEP_MS = 1500;

function estimateStepDuration(c: Command): number {
  if (c.verb === "wait") return Math.max(100, Number(c.duration_ms) || 0);
  return DEFAULT_STEP_MS;
}

export function TimelinePanel({
  onJumpTo,
}: {
  onJumpTo?: (byteOffset: number) => void;
}) {
  const ast = useEditorStore((s) => s.lastParse?.ast ?? null);

  if (!ast || ast.scenes.length === 0) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-3 py-2 text-xs text-[var(--color-fg-muted)]"
      >
        No scenes yet — add a <code className="font-mono">scene "\u2026"</code> block to see the timeline.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-secondary)]">
          Timeline
        </h2>
        <span className="text-xs text-[var(--color-fg-muted)]">
          {ast.scenes.length} scene{ast.scenes.length === 1 ? "" : "s"}
        </span>
      </header>
      <ol role="list" className="flex-1 overflow-auto p-3 flex flex-col gap-2">
        {ast.scenes.map((scene, idx) => {
          const totalMs = scene.commands.reduce((a, c) => a + estimateStepDuration(c), 0);
          return (
            <li key={`${scene.name}-${idx}`} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--color-fg-primary)]">
                  {scene.name || `Scene ${idx + 1}`}
                </span>
                <span className="text-[10px] text-[var(--color-fg-muted)]">
                  ~{(totalMs / 1000).toFixed(1)}s
                </span>
              </div>
              <div className="flex h-6 w-full items-stretch gap-[2px] rounded-sm bg-[var(--color-bg-primary)] overflow-hidden">
                {scene.commands.map((cmd, cidx) => {
                  const ms = estimateStepDuration(cmd);
                  const pct = totalMs > 0 ? (ms / totalMs) * 100 : 0;
                  return (
                    <button
                      key={cidx}
                      onClick={() => onJumpTo?.(cmd.span.start)}
                      aria-label={`Jump to ${cmd.verb} step at line ${cmd.span.line}`}
                      className="flex items-center justify-center bg-[var(--color-accent-primary)]/40 hover:bg-[var(--color-accent-primary)]/70 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] transition-colors"
                      style={{ flexBasis: `${pct}%` }}
                      title={`${cmd.verb} (${ms}ms)`}
                    >
                      <span className="text-[9px] font-mono text-[var(--color-fg-primary)] truncate px-1">
                        {cmd.verb}
                      </span>
                    </button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

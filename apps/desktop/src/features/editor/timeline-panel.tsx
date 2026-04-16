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
        className="flex h-full items-center justify-center px-5 text-xs text-[var(--color-fg-muted)]"
      >
        No scenes yet. Add a <code className="mx-1 font-mono">scene "…"</code> block to
        map the capture sequence.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-4 py-2">
        <span className="text-xs font-medium text-[var(--color-fg-muted)]">
          Timeline
        </span>
        <span className="font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
          {ast.scenes.length} {ast.scenes.length === 1 ? "scene" : "scenes"}
        </span>
      </header>

      <ol role="list" className="flex-1 overflow-auto px-5 py-4">
        <div className="space-y-4">
          {ast.scenes.map((scene, idx) => {
            const totalMs = scene.commands.reduce(
              (a, c) => a + estimateStepDuration(c),
              0,
            );

            return (
              <li
                key={`${scene.name}-${idx}`}
                className="grid gap-3 border-b border-[var(--color-border-subtle)] pb-4 last:border-b-0"
              >
                <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
                  <div>
                    <div className="text-sm font-medium text-[var(--color-fg-primary)]">
                      {scene.name || `Scene ${idx + 1}`}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
                      ~{(totalMs / 1000).toFixed(1)}s
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex h-8 w-full items-stretch gap-[3px] overflow-hidden rounded-full bg-[var(--color-surface-100)] p-[3px]">
                      {scene.commands.map((cmd, cidx) => {
                        const ms = estimateStepDuration(cmd);
                        const pct = totalMs > 0 ? (ms / totalMs) * 100 : 0;
                        return (
                          <button
                            key={cidx}
                            onClick={() => onJumpTo?.(cmd.span.start)}
                            aria-label={`Jump to ${cmd.verb} step at line ${cmd.span.line}`}
                            className="flex items-center justify-center rounded-full bg-[var(--color-accent-primary)]/20 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-primary)] transition-colors hover:bg-[var(--color-accent-primary)]/38 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                            style={{ flexBasis: `${pct}%` }}
                            title={`${cmd.verb} (${ms}ms)`}
                          >
                            <span className="truncate px-2">{cmd.verb}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {scene.commands.map((cmd, cidx) => (
                        <button
                          key={`${scene.name}-${idx}-chip-${cidx}`}
                          type="button"
                          onClick={() => onJumpTo?.(cmd.span.start)}
                          className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-100)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-secondary)] transition-colors hover:text-[var(--color-fg-primary)]"
                        >
                          {cmd.verb}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </div>
      </ol>
    </div>
  );
}

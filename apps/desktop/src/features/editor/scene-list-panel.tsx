/**
 * Scene list panel — compact navigation sidebar for jumping between scenes.
 * Follows the Descript / VS Code file explorer pattern: narrow, dense,
 * always-visible scene tree with active scene highlighting.
 */

import { useMemo } from "react";
import { Layers, ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { ScBadge } from "@storycapture/ui";

import { useEditorStore } from "@/state/editor";
import type { Scene } from "@/ipc/parse";

const EMPTY_DIAGNOSTICS: never[] = [];

const DEFAULT_STEP_MS = 1500;

function estimateSceneDuration(scene: Scene): number {
  return scene.commands.reduce((sum, cmd) => {
    if (cmd.verb === "wait") return sum + Math.max(100, Number(cmd.duration_ms) || 0);
    return sum + DEFAULT_STEP_MS;
  }, 0);
}

export function SceneListPanel({
  onJumpTo,
  activeSceneIndex,
  onSelectScene,
}: {
  onJumpTo?: (byteOffset: number) => void;
  activeSceneIndex?: number;
  onSelectScene?: (index: number) => void;
}) {
  const currentAst = useEditorStore((s) => s.lastParse?.ast ?? null);
  const diagnostics =
    useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;
  const lastValidAst = useEditorStore((s) => s.lastValidStoryAst);
  const reduceMotion = useReducedMotion();

  const hasParseError = diagnostics.some((d) => d.severity === "error");
  // Show last-valid tree when current parse failed; falls back to null → empty state.
  const renderAst = currentAst && !hasParseError ? currentAst : lastValidAst;
  const showStaleChip = hasParseError && lastValidAst !== null;

  const scenes = useMemo(() => {
    if (!renderAst) return [];
    return renderAst.scenes.map((scene, idx) => ({
      ...scene,
      index: idx,
      duration: estimateSceneDuration(scene),
    }));
  }, [renderAst]);

  return (
    <div className="flex h-full flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <Layers size={12} className="text-[var(--color-fg-muted)]" />
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
          Scenes
        </span>
        {scenes.length > 0 && !showStaleChip && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
            {scenes.length}
          </span>
        )}
        {showStaleChip && (
          <span className="ml-auto">
            <ScBadge tone="warn">parse error — showing last known</ScBadge>
          </span>
        )}
      </div>

      {/* Scene list */}
      {scenes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-3">
          <p className="text-center text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
            No scenes yet. Add <code className="font-mono text-[var(--color-fg-secondary)]">scene &quot;...&quot;</code> blocks
            to your script.
          </p>
        </div>
      ) : (
        <nav className="flex-1 overflow-y-auto py-1" aria-label="Scene navigation">
          {scenes.map((scene) => {
            const isActive = activeSceneIndex === scene.index;
            return (
              <button
                key={`scene-${scene.index}`}
                type="button"
                onClick={() => {
                  onSelectScene?.(scene.index);
                  onJumpTo?.(scene.span.start);
                }}
                className={`group relative flex w-full items-center gap-1.5 overflow-hidden px-2 py-1.5 text-left transition-colors ${
                  isActive
                    ? "text-[var(--color-fg-primary)]"
                    : "text-[var(--color-fg-secondary)] hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
                }`}
                title={scene.name || `Scene ${scene.index + 1}`}
              >
                {isActive ? (
                  <motion.span
                    layoutId="scene-list-active-pill"
                    className="absolute inset-x-1 inset-y-0 rounded-[var(--radius-md)] bg-[var(--color-accent-primary)]/8"
                    transition={
                      reduceMotion
                        ? { duration: 0.12 }
                        : { type: "spring", stiffness: 360, damping: 32 }
                    }
                  />
                ) : null}
                <ChevronRight
                  size={11}
                  className={`relative z-10 shrink-0 transition-transform ${
                    isActive
                      ? "rotate-90 text-[var(--color-accent-primary)]"
                      : "text-[var(--color-fg-muted)] group-hover:text-[var(--color-fg-secondary)]"
                  }`}
                />
                <div className="relative z-10 min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {scene.name || `Scene ${scene.index + 1}`}
                  </div>
                  <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
                    <span>{scene.commands.length} steps</span>
                    <span className="text-[var(--color-border-default)]">/</span>
                    <span>{(scene.duration / 1000).toFixed(1)}s</span>
                  </div>
                </div>
                {isActive && (
                  <motion.div
                    className="relative z-10 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent-primary)]"
                    initial={reduceMotion ? false : { scale: 0.72, opacity: 0.45 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                  />
                )}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

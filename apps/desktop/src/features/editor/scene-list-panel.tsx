import { ScBadge } from "@storycapture/ui";
import { ChevronRight, Layers } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";

import type { Command, Scene, SelectorOrText } from "@/ipc/parse";
import { EMPTY_DIAGNOSTICS, useEditorStore } from "@/state/editor";

import { verbIcon } from "./verb-icons";

const DEFAULT_STEP_MS = 1500;

function estimateSceneDuration(scene: Scene): number {
  return scene.commands.reduce((sum, cmd) => {
    if (cmd.verb === "wait") return sum + Math.max(100, Number(cmd.duration_ms) || 0);
    return sum + DEFAULT_STEP_MS;
  }, 0);
}

function targetLabel(t: SelectorOrText): string {
  switch (t.kind) {
    case "text":
      return t.value;
    case "selector":
      return `selector ${t.value}`;
    case "test_id":
      return `testid ${t.value}`;
    case "aria":
      return `aria ${t.value}`;
    case "role":
      return `${t.value.role} ${t.value.name}`;
    case "label":
      return `label ${t.value}`;
    case "text_exact":
      return `text ${t.value}`;
  }
}

function stepLabel(cmd: Command): string {
  switch (cmd.verb) {
    case "navigate":
      return cmd.url;
    case "click":
    case "hover":
    case "assert":
    case "assert-visible":
    case "wait-for":
    case "wait-for-visible":
      return targetLabel(cmd.target);
    case "type":
      return `${targetLabel(cmd.target)} → "${cmd.text}"`;
    case "select":
      return `${targetLabel(cmd.target)} → "${cmd.value}"`;
    case "upload":
      return `${targetLabel(cmd.target)} ← ${cmd.path}`;
    case "drag":
      return `${targetLabel(cmd.from)} → ${targetLabel(cmd.to)}`;
    case "scroll":
      return `${cmd.target ? `${targetLabel(cmd.target)} ` : ""}${cmd.direction} ${cmd.amount}${cmd.unit}`;
    case "wait":
      return `${cmd.duration_ms}ms`;
    case "screenshot":
      return cmd.name;
    case "pause":
      return "";
  }
}

interface SceneListPanelProps {
  activeSceneIndex?: number;
  onSelectScene?: (index: number) => void;
  onJumpTo?: (byteOffset: number) => void;
  cursorLine?: number;
}

export function SceneListPanel({
  onJumpTo,
  activeSceneIndex,
  onSelectScene,
  cursorLine,
}: SceneListPanelProps) {
  const currentAst = useEditorStore((s) => s.lastParse?.ast ?? null);
  const diagnostics = useEditorStore((s) => s.lastParse?.diagnostics) ?? EMPTY_DIAGNOSTICS;
  const lastValidAst = useEditorStore((s) => s.lastValidStoryAst);
  const reduceMotion = useReducedMotion();

  const hasParseError = diagnostics.some((d) => d.severity === "error");
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

  const activeStep = useMemo(() => {
    if (!cursorLine || scenes.length === 0) return null;
    for (let s = 0; s < scenes.length; s++) {
      const scene = scenes[s];
      const sceneStart = scene.span.line;
      const sceneEnd =
        s + 1 < scenes.length ? scenes[s + 1].span.line - 1 : Number.POSITIVE_INFINITY;
      if (cursorLine < sceneStart || cursorLine > sceneEnd) continue;
      let stepIdx = -1;
      for (let c = 0; c < scene.commands.length; c++) {
        if (scene.commands[c].span.line <= cursorLine) stepIdx = c;
        else break;
      }
      return { sceneIndex: s, stepIndex: stepIdx };
    }
    return null;
  }, [cursorLine, scenes]);

  return (
    <div className="flex h-full flex-col border-r border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-2">
        <Layers size={12} className="text-[var(--color-fg-muted)]" />
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
          Outline
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

      {scenes.length === 0 ? (
        <div className="flex h-full items-center justify-center p-3">
          <span className="font-mono text-[11px] italic text-[var(--sc-text-4)]">
            No scenes parsed
          </span>
        </div>
      ) : (
        <nav className="flex-1 overflow-y-auto py-1" aria-label="Document outline">
          {scenes.map((scene) => {
            const isActiveScene = activeSceneIndex === scene.index;
            return (
              <div key={`scene-${scene.index}`}>
                <button
                  type="button"
                  onClick={() => {
                    onSelectScene?.(scene.index);
                    onJumpTo?.(scene.span.start);
                  }}
                  className={`group relative flex w-full items-center gap-1.5 overflow-hidden py-1.5 text-left transition-colors ${
                    isActiveScene
                      ? "border-l-2 border-[var(--sc-accent-400)] pl-[6px] pr-2 text-[var(--color-fg-primary)]"
                      : "px-2 text-[var(--color-fg-secondary)] hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-primary)]"
                  }`}
                  title={scene.name || `Scene ${scene.index + 1}`}
                >
                  <ChevronRight
                    size={11}
                    className={`relative z-10 shrink-0 transition-transform ${
                      isActiveScene
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
                  {isActiveScene && (
                    <motion.div
                      className="relative z-10 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent-primary)]"
                      initial={reduceMotion ? false : { scale: 0.72, opacity: 0.45 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.16, ease: "easeOut" }}
                    />
                  )}
                </button>

                {scene.commands.length > 0 && (
                  <ul className="mb-0.5 list-none pl-4">
                    {scene.commands.map((cmd, stepIdx) => {
                      const Icon = verbIcon(cmd.verb);
                      const isActiveStep =
                        activeStep?.sceneIndex === scene.index && activeStep.stepIndex === stepIdx;
                      const label = stepLabel(cmd);
                      return (
                        <li key={`step-${cmd.span.start}`}>
                          <button
                            type="button"
                            onClick={() => onJumpTo?.(cmd.span.start)}
                            className={`flex w-full items-center gap-1.5 overflow-hidden py-1 pr-2 text-left transition-colors ${
                              isActiveStep
                                ? "border-l-2 border-[var(--sc-accent-400)] pl-[6px] text-[var(--color-fg-primary)]"
                                : "border-l-2 border-transparent pl-[6px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-300)] hover:text-[var(--color-fg-secondary)]"
                            }`}
                            title={`${stepIdx + 1}. ${cmd.verb} ${label}`}
                          >
                            <Icon size={10} aria-hidden="true" className="shrink-0" />
                            <span className="truncate font-mono text-[10.5px]">
                              <span className="text-[var(--color-fg-muted)]">{stepIdx + 1}.</span>{" "}
                              <span className="text-[var(--sc-text-2)]">{cmd.verb}</span>
                              {label && (
                                <span className="text-[var(--color-fg-muted)]"> {label}</span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </nav>
      )}
    </div>
  );
}

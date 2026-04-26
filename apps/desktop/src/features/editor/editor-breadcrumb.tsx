import { ChevronRight } from "lucide-react";
import { useMemo } from "react";

import type { Command, Scene, Story } from "@/ipc/parse";

interface EditorBreadcrumbProps {
  story: Story;
  cursorLine: number;
  onJumpToOffset: (offset: number) => void;
}

interface Resolved {
  sceneIndex: number;
  scene: Scene;
  stepIndex: number | null;
  step: Command | null;
}

function resolve(story: Story, cursorLine: number): Resolved | null {
  if (story.scenes.length === 0) return null;
  let sceneIndex = -1;
  for (let i = 0; i < story.scenes.length; i++) {
    const start = story.scenes[i].span.line;
    if (cursorLine >= start) sceneIndex = i;
    else break;
  }
  if (sceneIndex < 0) return null;
  const scene = story.scenes[sceneIndex];
  let stepIndex: number | null = null;
  for (let j = 0; j < scene.commands.length; j++) {
    if (scene.commands[j].span.line <= cursorLine) stepIndex = j;
    else break;
  }
  return {
    sceneIndex,
    scene,
    stepIndex,
    step: stepIndex !== null ? scene.commands[stepIndex] : null,
  };
}

const SEG_BASE: React.CSSProperties = {
  fontSize: 12.5,
  fontFamily: "var(--sc-font-mono)",
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--sc-text-3)",
};

const SEG_ACTIVE: React.CSSProperties = {
  ...SEG_BASE,
  color: "var(--sc-text)",
};

const CHEVRON_STYLE = { color: "var(--sc-text-4)" } as const;

export function EditorBreadcrumb({ story, cursorLine, onJumpToOffset }: EditorBreadcrumbProps) {
  const resolved = useMemo(() => resolve(story, cursorLine), [story, cursorLine]);
  if (!resolved) return null;
  const { scene, sceneIndex, step, stepIndex } = resolved;
  const sceneLabel = scene.name?.trim().length
    ? `Scene "${scene.name}"`
    : `Scene ${sceneIndex + 1}`;

  return (
    <>
      <ChevronRight size={10} aria-hidden="true" style={CHEVRON_STYLE} />
      <button
        type="button"
        style={step ? SEG_BASE : SEG_ACTIVE}
        onClick={() => onJumpToOffset(scene.span.start)}
        aria-label={`Jump to ${sceneLabel}`}
      >
        {sceneLabel}
      </button>
      {step && stepIndex !== null && (
        <>
          <ChevronRight size={10} aria-hidden="true" style={CHEVRON_STYLE} />
          <button
            type="button"
            style={SEG_ACTIVE}
            onClick={() => onJumpToOffset(step.span.start)}
            aria-label={`Jump to step ${stepIndex + 1} (${step.verb})`}
          >
            {`Step ${stepIndex + 1} (${step.verb})`}
          </button>
        </>
      )}
    </>
  );
}

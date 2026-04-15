/**
 * Resizable split pane using `react-resizable-panels` (UI-02). Ratio is
 * controlled by the editor Zustand store so user can persist it across
 * sessions (a later plan wires `tauri-plugin-store`).
 */

import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ReactNode } from "react";

import { useEditorStore } from "@/state/editor";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  direction?: "horizontal" | "vertical";
}

export function SplitPane({ left, right, direction = "horizontal" }: SplitPaneProps) {
  const splitRatio = useEditorStore((s) => s.splitRatio);
  const setSplitRatio = useEditorStore((s) => s.setSplitRatio);

  return (
    <PanelGroup
      direction={direction}
      onLayout={(sizes) => {
        if (sizes.length === 2) setSplitRatio(sizes[0]);
      }}
      className="h-full w-full"
    >
      <Panel defaultSize={splitRatio} minSize={20} className="h-full">
        {left}
      </Panel>
      <PanelResizeHandle
        aria-label="Resize editor pane"
        className={
          direction === "horizontal"
            ? "w-1 bg-[var(--color-border-subtle)] hover:bg-[var(--color-accent-primary)] focus-visible:bg-[var(--color-accent-primary)] transition-colors"
            : "h-1 bg-[var(--color-border-subtle)] hover:bg-[var(--color-accent-primary)] focus-visible:bg-[var(--color-accent-primary)] transition-colors"
        }
      />
      <Panel defaultSize={100 - splitRatio} minSize={20} className="h-full">
        {right}
      </Panel>
    </PanelGroup>
  );
}

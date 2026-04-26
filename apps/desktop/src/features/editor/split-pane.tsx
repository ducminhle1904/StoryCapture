/**
 * Resizable split pane using `react-resizable-panels` v4. Ratio is
 * controlled by the editor Zustand store so users can persist it across
 * sessions (`tauri-plugin-store` wiring is pending).
 */

import { Group, Panel, Separator } from "react-resizable-panels";
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
    <Group
      orientation={direction}
      onLayoutChanged={(layout) => {
        const left = layout["split-left"];
        if (typeof left === "number") setSplitRatio(left);
      }}
      className="h-full w-full"
    >
      <Panel
        id="split-left"
        defaultSize={`${splitRatio}%`}
        minSize="20%"
        className="h-full"
      >
        {left}
      </Panel>
      <Separator
        className={
          direction === "horizontal"
            ? "w-1 bg-[var(--color-border-subtle)] hover:bg-[var(--color-accent-primary)] focus-visible:bg-[var(--color-accent-primary)] transition-colors"
            : "h-1 bg-[var(--color-border-subtle)] hover:bg-[var(--color-accent-primary)] focus-visible:bg-[var(--color-accent-primary)] transition-colors"
        }
      />
      <Panel
        id="split-right"
        defaultSize={`${100 - splitRatio}%`}
        minSize="20%"
        className="h-full"
      >
        {right}
      </Panel>
    </Group>
  );
}

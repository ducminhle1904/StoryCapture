import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Scene, Story } from "@/ipc/parse";
import { useEditorStore } from "@/state/editor";

import { SceneListPanel } from "./scene-list-panel";

function span(line: number, start: number) {
  return { line, col: 1, start, end: start + 5 };
}

function makeStory(): Story {
  const scenes: Scene[] = [
    {
      name: "Intro",
      span: span(2, 20),
      commands: [
        { verb: "navigate", url: "https://example.com", span: span(3, 30) },
        { verb: "click", target: { kind: "text", value: "Sign In" }, span: span(5, 50) },
      ],
    },
    {
      name: "Outro",
      span: span(10, 100),
      commands: [
        { verb: "type", target: { kind: "selector", value: "#a" }, text: "hi", span: span(11, 110) },
      ],
    },
  ];
  return {
    name: "demo",
    meta: { app: null, viewport: null, theme: null, speed: null, span: span(1, 0) },
    scenes,
    span: span(1, 0),
  };
}

function seed(story: Story | null) {
  act(() => {
    useEditorStore.setState({
      lastParse: story ? { ast: story, diagnostics: [] } : null,
      lastValidStoryAst: story,
    });
  });
}

describe("SceneListPanel outline", () => {
  beforeEach(() => {
    useEditorStore.setState({ lastParse: null, lastValidStoryAst: null });
  });
  afterEach(() => {
    useEditorStore.setState({ lastParse: null, lastValidStoryAst: null });
  });

  it("renders steps under each scene", () => {
    seed(makeStory());
    render(<SceneListPanel />);
    expect(screen.getByText(/Sign In/)).toBeInTheDocument();
    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/hi/)).toBeInTheDocument();
  });

  it("clicking a step calls onJumpTo with command.span.start", async () => {
    seed(makeStory());
    const onJumpTo = vi.fn();
    render(<SceneListPanel onJumpTo={onJumpTo} />);
    const stepBtn = screen.getByTitle("2. click Sign In");
    await userEvent.click(stepBtn);
    expect(onJumpTo).toHaveBeenCalledWith(50);
  });

  it("highlights the active step when cursor falls within its range", () => {
    seed(makeStory());
    const { container } = render(<SceneListPanel cursorLine={5} />);
    const stepBtn = container.querySelector('[title="2. click Sign In"]');
    expect(stepBtn?.className).toMatch(/border-\[var\(--sc-accent-400\)\]/);
  });

  it("shows empty state when no scenes parsed", () => {
    seed(null);
    render(<SceneListPanel />);
    expect(screen.getByText("No scenes parsed")).toBeInTheDocument();
  });
});

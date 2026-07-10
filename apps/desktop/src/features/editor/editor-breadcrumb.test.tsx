import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Scene, Story } from "@/ipc/parse";

import { EditorBreadcrumb } from "./editor-breadcrumb";

function span(line: number, start = line * 10) {
  return { line, col: 1, start, end: start + 5 };
}

function makeStory(): Story {
  const scenes: Scene[] = [
    {
      name: "Intro",
      span: span(2, 20),
      commands: [
        { verb: "navigate", url: "https://x", span: span(3, 30) },
        { verb: "click", target: { kind: "text", value: "Go" }, span: span(5, 50) },
      ],
    },
    {
      name: "",
      span: span(10, 100),
      commands: [
        {
          verb: "type",
          target: { kind: "selector", value: "#a" },
          text: "hi",
          span: span(11, 110),
        },
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

describe("EditorBreadcrumb", () => {
  it("renders nothing when cursor is above first scene", () => {
    const { container } = render(
      <EditorBreadcrumb story={makeStory()} cursorLine={1} onJumpToOffset={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows scene + step segments when cursor sits on a step", () => {
    render(<EditorBreadcrumb story={makeStory()} cursorLine={5} onJumpToOffset={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Jump to Scene "Intro"/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Jump to step 2 \(click\)/ })).toBeInTheDocument();
  });

  it("falls back to numbered scene name when scene.name is empty", () => {
    render(<EditorBreadcrumb story={makeStory()} cursorLine={11} onJumpToOffset={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Jump to Scene 2/ })).toBeInTheDocument();
  });

  it("clicking scene segment jumps to scene.span.start", async () => {
    const onJump = vi.fn();
    render(<EditorBreadcrumb story={makeStory()} cursorLine={5} onJumpToOffset={onJump} />);
    await userEvent.click(screen.getByRole("button", { name: /Jump to Scene "Intro"/ }));
    expect(onJump).toHaveBeenCalledWith(20);
  });

  it("clicking step segment jumps to command.span.start", async () => {
    const onJump = vi.fn();
    render(<EditorBreadcrumb story={makeStory()} cursorLine={5} onJumpToOffset={onJump} />);
    await userEvent.click(screen.getByRole("button", { name: /Jump to step 2/ }));
    expect(onJump).toHaveBeenCalledWith(50);
  });

  it("blank line between scene start and first step still resolves to scene", () => {
    render(<EditorBreadcrumb story={makeStory()} cursorLine={2} onJumpToOffset={vi.fn()} />);
    // Cursor on scene-start line; no step yet — only the scene segment.
    expect(screen.getByRole("button", { name: /Jump to Scene "Intro"/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Jump to step/ })).toBeNull();
  });
});

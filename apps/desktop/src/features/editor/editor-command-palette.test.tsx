import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("@/ipc/simulator", () => ({
  simulatorStart: vi.fn().mockResolvedValue("session-1"),
  simulatorCancel: vi.fn().mockResolvedValue(undefined),
  simulatorStepTo: vi.fn().mockResolvedValue(undefined),
}));

import type { Scene, Story } from "@/ipc/parse";
import { useEditorStore } from "@/state/editor";

import { editorController } from "./controller";
import { EditorCommandPalette } from "./editor-command-palette";
import { useProblemsPanelStore } from "./problems-panel";

function span(line: number, start: number) {
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

function defaults(overrides: Partial<React.ComponentProps<typeof EditorCommandPalette>> = {}) {
  return {
    story: makeStory(),
    projectFolder: "/tmp/proj",
    storyPath: "/tmp/proj/demo.story",
    streamId: "stream-1",
    onJumpToOffset: vi.fn(),
    ...overrides,
  };
}

describe("EditorCommandPalette", () => {
  beforeEach(() => {
    editorController.clearView();
    useEditorStore.setState({ source: "" });
    useProblemsPanelStore.setState({ open: false });
  });
  afterEach(() => {
    editorController.clearView();
  });

  it("does not render the dialog until Cmd+Shift+K is pressed", async () => {
    const user = userEvent.setup();
    render(<EditorCommandPalette {...defaults()} />);
    expect(screen.queryByPlaceholderText(/Type a command/)).toBeNull();
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    expect(screen.getByPlaceholderText(/Type a command/)).toBeInTheDocument();
  });

  it("Escape from root mode closes the palette", async () => {
    const user = userEvent.setup();
    render(<EditorCommandPalette {...defaults()} />);
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText(/Type a command/)).toBeNull();
  });

  it("'Go to Line…' switches to numeric line input mode", async () => {
    const user = userEvent.setup();
    render(<EditorCommandPalette {...defaults()} />);
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await user.click(screen.getByText("Go to Line…"));
    expect(screen.getByPlaceholderText(/Line number/)).toBeInTheDocument();
  });

  it("Escape from sub-mode returns to root, not close", async () => {
    const user = userEvent.setup();
    render(<EditorCommandPalette {...defaults()} />);
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await user.click(screen.getByText("Go to Scene…"));
    expect(screen.getByText("Intro")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByPlaceholderText(/Type a command/)).toBeInTheDocument();
  });

  it("selecting a scene calls onJumpToOffset with scene.span.start", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<EditorCommandPalette {...defaults({ onJumpToOffset: onJump })} />);
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await user.click(screen.getByText("Go to Scene…"));
    await user.click(screen.getByText("Intro"));
    expect(onJump).toHaveBeenCalledWith(20);
  });

  it("'Toggle Line Comment' is hidden when no editor view is registered", async () => {
    const user = userEvent.setup();
    render(<EditorCommandPalette {...defaults()} />);
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    expect(screen.queryByText("Toggle Line Comment")).toBeNull();
  });
});

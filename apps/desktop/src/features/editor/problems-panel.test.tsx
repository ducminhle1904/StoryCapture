import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Diagnostic } from "@/ipc/parse";
import { useEditorStore } from "@/state/editor";

import { ProblemsPanel } from "./problems-panel";

function span(line: number, start: number) {
  return { line, col: 1, start, end: start + 5 };
}

function diag(
  severity: Diagnostic["severity"],
  message: string,
  line: number,
  start: number,
  suggestion: string | null = null,
): Diagnostic {
  return { severity, message, suggestion, span: span(line, start) };
}

function seedDiagnostics(diagnostics: Diagnostic[]) {
  act(() => {
    useEditorStore.setState({
      lastParse: { ast: null, diagnostics },
    });
  });
}

describe("ProblemsPanel", () => {
  beforeEach(() => {
    useEditorStore.setState({ lastParse: null });
  });
  afterEach(() => {
    useEditorStore.setState({ lastParse: null });
  });

  it("shows 'No problems' badge and collapsed body by default", () => {
    seedDiagnostics([]);
    render(<ProblemsPanel onJumpToOffset={vi.fn()} />);
    expect(screen.getByText("No problems")).toBeInTheDocument();
    expect(screen.queryByText("No problems detected")).toBeNull();
  });

  it("counts errors and warnings in the header", () => {
    seedDiagnostics([
      diag("error", "bad verb", 2, 10),
      diag("error", "bad target", 3, 20),
      diag("warning", "deprecated", 4, 30),
    ]);
    render(<ProblemsPanel onJumpToOffset={vi.fn()} />);
    expect(screen.getByText("2 errors")).toBeInTheDocument();
    expect(screen.getByText("1 warning")).toBeInTheDocument();
  });

  it("clicking the header opens the body and lists rows", async () => {
    seedDiagnostics([diag("error", "bad verb", 2, 10, "click")]);
    render(<ProblemsPanel onJumpToOffset={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Problems/i }));
    expect(screen.getByText("bad verb")).toBeInTheDocument();
    expect(screen.getByText(/did you mean "click"\?/)).toBeInTheDocument();
    expect(screen.getByText("Ln 2, Col 1")).toBeInTheDocument();
  });

  it("Cmd+Shift+M toggles the body open", async () => {
    seedDiagnostics([diag("error", "bad verb", 2, 10)]);
    render(<ProblemsPanel onJumpToOffset={vi.fn()} />);
    await userEvent.keyboard("{Meta>}{Shift>}m{/Shift}{/Meta}");
    expect(screen.getByText("bad verb")).toBeInTheDocument();
  });

  it("clicking a diagnostic row calls onJumpToOffset with span.start", async () => {
    const onJump = vi.fn();
    seedDiagnostics([diag("error", "bad verb", 2, 42)]);
    render(<ProblemsPanel onJumpToOffset={onJump} />);
    await userEvent.click(screen.getByRole("button", { name: /Problems/i }));
    await userEvent.click(screen.getByRole("button", { name: /bad verb/ }));
    expect(onJump).toHaveBeenCalledWith(42);
  });

  it("when open with zero diagnostics shows empty-state copy", async () => {
    seedDiagnostics([]);
    render(<ProblemsPanel onJumpToOffset={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Problems/i }));
    expect(screen.getByText("No problems detected")).toBeInTheDocument();
  });
});

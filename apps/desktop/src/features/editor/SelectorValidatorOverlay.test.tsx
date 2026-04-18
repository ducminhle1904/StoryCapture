/**
 * Plan 07-05 — unit tests for the author-time validator overlay.
 *
 * Stubs `@tauri-apps/api/core` `invoke` via Vitest's `vi.mock` so the
 * overlay's debounced `author_snapshot_validate` calls land in a
 * controllable mock rather than the real Tauri bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

import type { Command, ParseResult, Story } from "@/ipc/parse";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/state/editor";
import {
  SelectorValidatorOverlay,
  chipStateChar,
  collectValidatableSteps,
  useSelectorValidation,
} from "./SelectorValidatorOverlay";

function span(line: number, col = 0) {
  return { start: 0, end: 0, line, col };
}

function clickCmd(line: number, testId: string): Command {
  return {
    verb: "click",
    target: { kind: "test_id", value: testId },
    span: span(line),
  };
}

function navigate(line: number, url: string): Command {
  return { verb: "navigate", url, span: span(line) };
}

function storyWith(commands: Command[], metaApp: string | null = null): Story {
  return {
    name: null,
    meta: {
      app: metaApp,
      viewport: null,
      theme: null,
      speed: null,
      span: span(0),
    },
    scenes: [
      {
        name: "s1",
        commands,
        span: span(0),
      },
    ],
    span: span(0),
  };
}

function parseResult(ast: Story | null): ParseResult {
  return { ast, diagnostics: [] };
}

describe("collectValidatableSteps", () => {
  it("uses meta.app as fallback url when no Navigate appears", () => {
    const story = storyWith([clickCmd(3, "save")], "https://example.com/");
    const steps = collectValidatableSteps(story);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ line: 3, url: "https://example.com/" });
  });

  it("propagates the latest Navigate url forward", () => {
    const story = storyWith([
      navigate(1, "https://a.com"),
      clickCmd(2, "x"),
      navigate(3, "https://b.com"),
      clickCmd(4, "y"),
    ]);
    const steps = collectValidatableSteps(story);
    expect(steps.map((s) => ({ line: s.line, url: s.url }))).toEqual([
      { line: 2, url: "https://a.com" },
      { line: 4, url: "https://b.com" },
    ]);
  });

  it("skips steps with no active url (no Navigate, no meta.app)", () => {
    const story = storyWith([clickCmd(1, "save")], null);
    expect(collectValidatableSteps(story)).toEqual([]);
  });
});

describe("chipStateChar", () => {
  it("maps every AuthorValidation arm", () => {
    expect(chipStateChar(null)).toBe("?");
    expect(chipStateChar({ status: "unique", strategy: "testid" })).toBe("G");
    expect(chipStateChar({ status: "fuzzy", count: 2, reason: "r" })).toBe("Y");
    expect(chipStateChar({ status: "none" })).toBe("R");
    expect(chipStateChar({ status: "no_snapshot" })).toBe("_");
  });
});

describe("SelectorValidatorOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (invoke as any).mockReset();
    useEditorStore.setState({ source: "", lastParse: null } as any);
    useSelectorValidation.getState().clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("returns null when no project dir is set", () => {
    const { container } = render(
      <SelectorValidatorOverlay projectDir={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it(
    "debounces validate IPC and writes into the store",
    async () => {
      (invoke as any).mockResolvedValue({
        status: "unique",
        strategy: "testid",
      });
      useEditorStore.setState({
        lastParse: parseResult(
          storyWith(
            [navigate(1, "https://x.test/"), clickCmd(2, "save")],
          ),
        ),
      } as any);
      render(<SelectorValidatorOverlay projectDir="/fake/proj" debounceMs={250} />);

      // Before the debounce elapses the entry is "pending" (null status).
      // Flush React effect microtasks.
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        useSelectorValidation.getState().entries.get(2)?.status,
      ).toBeNull();
      expect((invoke as any)).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(260);
      });

      // Let the resolved microtask flush.
      await act(async () => {
        await Promise.resolve();
      });

      expect((invoke as any)).toHaveBeenCalledWith(
        "author_snapshot_validate",
        expect.objectContaining({
          projectDir: "/fake/proj",
          url: "https://x.test/",
          targetJson: expect.stringContaining("test_id"),
        }),
      );
      const entry = useSelectorValidation.getState().entries.get(2);
      expect(entry?.status).toEqual({ status: "unique", strategy: "testid" });
    },
  );

  it(
    "drops stale lines when a command is removed",
    async () => {
      (invoke as any).mockResolvedValue({ status: "none" });
      useEditorStore.setState({
        lastParse: parseResult(
          storyWith([navigate(1, "https://x/"), clickCmd(2, "save")]),
        ),
      } as any);
      const { rerender } = render(
        <SelectorValidatorOverlay projectDir="/p" debounceMs={50} />,
      );
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      expect(useSelectorValidation.getState().entries.has(2)).toBe(true);

      // Re-parse without the click step.
      useEditorStore.setState({
        lastParse: parseResult(storyWith([navigate(1, "https://x/")])),
      } as any);
      rerender(<SelectorValidatorOverlay projectDir="/p" debounceMs={50} />);
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      // The stale entry for line 2 should have been dropped from tracking
      // (no new IPC calls; the store may retain the last value but the
      // pending/key maps are cleared).
      // We assert the IPC wasn't called a 2nd time for line 2.
      expect((invoke as any).mock.calls.length).toBe(1);
    },
  );
});

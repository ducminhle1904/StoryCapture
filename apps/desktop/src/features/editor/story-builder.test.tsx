import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Story } from "@/ipc/parse";
import { parseStorySource } from "../../../electron/ipc/story-parser";
import { DEFAULT_POLISH_DOC, type StoryPolishDoc } from "./polish-sidecar";
import { StoryBuilder } from "./story-builder";
import { formatEditableStory } from "./story-ui-model";

const SOURCE_WITH_TWO_COMMANDS = `story "Manual QA" {
  meta {
    app: "http://127.0.0.1:18575/"
    viewport: 1280x800
  }
  scene "Manual QA" {
    navigate "http://127.0.0.1:18575/"
    click button "Start"
  }
}
`;

const SOURCE_WITH_TEXT_OVERLAY = `story "Text overlay" {
  scene "Intro" {
    text-overlay "Welcome" 2000ms  # @id=12345678-1234-1234-1234-123456789abc
  }
}
`;

function parseStory(source: string): Story {
  const ast = parseStorySource(source).ast as Story | null;
  expect(ast).toBeTruthy();
  return ast!;
}

interface HarnessProps {
  initialStory: Story;
  initialPolish?: StoryPolishDoc;
  simulatorActive?: boolean;
  onSourceChange?: (source: string, story?: Story) => void;
  onValidityChange?: (valid: boolean) => void;
}

function StoryBuilderHarness({
  initialStory,
  initialPolish = DEFAULT_POLISH_DOC,
  simulatorActive = false,
  onSourceChange = () => {},
  onValidityChange,
}: HarnessProps) {
  const [story, setStory] = useState(initialStory);
  const [source, setSource] = useState(formatEditableStory(initialStory));
  const [polish, setPolish] = useState<StoryPolishDoc>(initialPolish);

  return (
    <StoryBuilder
      story={story}
      polish={polish}
      simulatorActive={simulatorActive}
      storySource={source}
      storyPath={null}
      streamId={null}
      onSourceChange={(nextSource, optimisticStory) => {
        onSourceChange(nextSource, optimisticStory);
        setSource(nextSource);
        if (optimisticStory) setStory(optimisticStory);
      }}
      onSourceCommit={async (nextSource, optimisticStory) => {
        setSource(nextSource);
        if (optimisticStory) setStory(optimisticStory);
      }}
      onPolishChange={setPolish}
      onJumpToOffset={() => {}}
      onValidityChange={onValidityChange}
    />
  );
}

describe("StoryBuilder UI/code synchronization", () => {
  it("renders a UI row for a command added in source", () => {
    render(<StoryBuilderHarness initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)} />);

    expect(screen.getByLabelText("Navigate value")).toHaveValue("http://127.0.0.1:18575/");
    expect(screen.getByLabelText("Click value")).toHaveValue("Start");
  });

  it("keeps UI edits controlled by the optimistic story while source reparses later", async () => {
    const user = userEvent.setup();
    const sourceChanges: string[] = [];
    render(
      <StoryBuilderHarness
        initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)}
        onSourceChange={(source) => sourceChanges.push(source)}
      />,
    );

    const clickValue = screen.getByLabelText("Click value");
    await user.clear(clickValue);
    await user.type(clickValue, "Continue");

    expect(clickValue).toHaveValue("Continue");
    expect(sourceChanges.at(-1)).toContain('click <button> "Continue"');
  });

  it("edits text overlay text and duration with canonical serialization", async () => {
    const user = userEvent.setup();
    const sourceChanges: string[] = [];
    render(
      <StoryBuilderHarness
        initialStory={parseStory(SOURCE_WITH_TEXT_OVERLAY)}
        onSourceChange={(source) => sourceChanges.push(source)}
      />,
    );

    const text = screen.getByLabelText(/^Text overlay text/);
    const duration = screen.getByLabelText(/^Text overlay duration/);
    expect(screen.getByText("Text overlay")).toBeInTheDocument();
    expect(text).toHaveValue("Welcome");
    expect(duration).toHaveValue(2_000);

    await user.clear(text);
    await user.type(text, "A clearer title");
    await user.clear(duration);
    await user.type(duration, "5000");

    expect(sourceChanges.at(-1)).toContain(
      'text-overlay "A clearer title" 5000ms  # @id=12345678-1234-1234-1234-123456789abc',
    );
  });

  it("shows text overlay validation without clamping or committing invalid fields", () => {
    const sourceChanges: string[] = [];
    const validityChanges: boolean[] = [];
    render(
      <StoryBuilderHarness
        initialStory={parseStory(SOURCE_WITH_TEXT_OVERLAY)}
        onSourceChange={(source) => sourceChanges.push(source)}
        onValidityChange={(valid) => validityChanges.push(valid)}
      />,
    );

    const text = screen.getByLabelText(/^Text overlay text/);
    const duration = screen.getByLabelText(/^Text overlay duration/);
    fireEvent.change(text, { target: { value: "" } });
    fireEvent.change(duration, { target: { value: "99" } });

    expect(text).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/text must not be empty/)).toBeInTheDocument();
    expect(duration).toHaveValue(99);
    expect(duration).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/between 100ms and 30000ms/)).toBeInTheDocument();
    expect(sourceChanges).toEqual([]);
    expect(validityChanges.at(-1)).toBe(false);

    fireEvent.change(duration, { target: { value: "2000" } });
    expect(validityChanges.at(-1)).toBe(false);
    fireEvent.change(text, { target: { value: "Welcome" } });
    expect(validityChanges.at(-1)).toBe(true);
  });

  it("persists Full and Reduced Motion selection in project polish", async () => {
    const user = userEvent.setup();
    render(<StoryBuilderHarness initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)} />);

    const fullMotion = screen.getByRole("radio", { name: "Full" });
    const reducedMotion = screen.getByRole("radio", { name: "Reduced" });
    expect(fullMotion).toHaveAttribute("aria-checked", "true");

    await user.click(reducedMotion);

    expect(reducedMotion).toHaveAttribute("aria-checked", "true");
    expect(fullMotion).toHaveAttribute("aria-checked", "false");
  });

  it("defaults zoom duration to 1600 ms and clamps manual input to 900 ms", () => {
    render(<StoryBuilderHarness initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)} />);

    const duration = screen.getByLabelText("Auto zoom duration");
    expect(duration).toHaveValue(1_600);
    expect(duration).toHaveAttribute("min", "900");

    fireEvent.change(duration, { target: { value: "500" } });

    expect(duration).toHaveValue(900);
  });

  it("does not overwrite a manually edited duration when the auto zoom preset changes", async () => {
    const user = userEvent.setup();
    render(<StoryBuilderHarness initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)} />);

    const duration = screen.getByLabelText("Auto zoom duration");
    fireEvent.change(duration, { target: { value: "2200" } });

    await user.click(screen.getByLabelText("Auto zoom"));
    await user.click(
      within(screen.getByRole("listbox", { name: "Auto zoom" })).getByRole("option", {
        name: "Strong",
      }),
    );

    expect(duration).toHaveValue(2_200);
  });

  it("preserves a persisted custom duration when the preset changes", async () => {
    const user = userEvent.setup();
    render(
      <StoryBuilderHarness
        initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)}
        initialPolish={{
          ...DEFAULT_POLISH_DOC,
          global: { ...DEFAULT_POLISH_DOC.global, autoZoomDurationMs: 2_400 },
        }}
      />,
    );

    await user.click(screen.getByLabelText("Auto zoom"));
    await user.click(
      within(screen.getByRole("listbox", { name: "Auto zoom" })).getByRole("option", {
        name: "Strong",
      }),
    );

    expect(screen.getByLabelText("Auto zoom duration")).toHaveValue(2_400);
  });

  it("disables motion controls while the simulator is active", () => {
    render(
      <StoryBuilderHarness initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)} simulatorActive />,
    );

    expect(screen.getByRole("radiogroup", { name: "Motion mode" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByLabelText("Auto zoom duration")).toBeDisabled();
  });
});

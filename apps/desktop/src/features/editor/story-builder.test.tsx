import { fireEvent, render, screen } from "@testing-library/react";
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
}

function StoryBuilderHarness({
  initialStory,
  initialPolish = DEFAULT_POLISH_DOC,
  simulatorActive = false,
  onSourceChange = () => {},
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

  it("persists Full and Reduced Motion selection in project polish", async () => {
    const user = userEvent.setup();
    render(<StoryBuilderHarness initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)} />);

    const fullMotion = screen.getByRole("button", { name: "Full" });
    const reducedMotion = screen.getByRole("button", { name: "Reduced" });
    expect(fullMotion).toHaveAttribute("aria-pressed", "true");

    await user.click(reducedMotion);

    expect(reducedMotion).toHaveAttribute("aria-pressed", "true");
    expect(fullMotion).toHaveAttribute("aria-pressed", "false");
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
    await user.click(screen.getByRole("option", { name: "Strong" }));

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
    await user.click(screen.getByRole("option", { name: "Strong" }));

    expect(screen.getByLabelText("Auto zoom duration")).toHaveValue(2_400);
  });

  it("disables motion controls while the simulator is active", () => {
    render(
      <StoryBuilderHarness
        initialStory={parseStory(SOURCE_WITH_TWO_COMMANDS)}
        simulatorActive
      />,
    );

    expect(screen.getByLabelText("Motion mode")).toHaveAttribute("data-disabled");
    expect(screen.getByLabelText("Auto zoom duration")).toBeDisabled();
  });
});

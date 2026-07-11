import { render, screen } from "@testing-library/react";
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
  onSourceChange?: (source: string, story?: Story) => void;
}

function StoryBuilderHarness({ initialStory, onSourceChange = () => {} }: HarnessProps) {
  const [story, setStory] = useState(initialStory);
  const [source, setSource] = useState(formatEditableStory(initialStory));
  const [polish, setPolish] = useState<StoryPolishDoc>(DEFAULT_POLISH_DOC);

  return (
    <StoryBuilder
      story={story}
      polish={polish}
      simulatorActive={false}
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
});

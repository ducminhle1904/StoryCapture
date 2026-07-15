import { describe, expect, it } from "vitest";
import type { Story } from "@/ipc/parse";
import { normalizePolishDoc, prunePolishDocForStory, type StoryPolishDoc } from "./polish-sidecar";
import {
  cloneStoryWithStepId,
  commandSupportsPick,
  commandSupportsVisualFocus,
  ensureAllStepIds,
  formatEditableStory,
  patchCommand,
  updateCommandTargetFromPick,
} from "./story-ui-model";

const STORY: Story = {
  name: "Demo",
  meta: {
    app: "https://example.com",
    viewport: { width: 1280, height: 720 },
    theme: null,
    speed: null,
    span: { start: 0, end: 0, line: 1, col: 1 },
  },
  span: { start: 0, end: 0, line: 1, col: 1 },
  scenes: [
    {
      name: "Checkout",
      span: { start: 0, end: 0, line: 3, col: 3 },
      commands: [
        {
          verb: "navigate",
          url: "https://example.com",
          span: { start: 0, end: 0, line: 4, col: 5 },
          step_id: null,
        },
        {
          verb: "click",
          target: { kind: "role", value: { role: "button", name: "Buy now" } },
          span: { start: 0, end: 0, line: 5, col: 5 },
          step_id: "step-buy",
        },
      ],
    },
  ],
};

describe("story-ui-model", () => {
  it("formats editable stories with step ids", () => {
    const text = formatEditableStory(STORY);
    expect(text).toContain('app: "https://example.com"');
    expect(text).toContain('click <button> "Buy now"  # @id=step-buy');
  });

  it("preserves nth modifiers for single and drag targets", () => {
    const story = structuredClone(STORY);
    story.scenes[0]?.commands.push(
      {
        verb: "type",
        target: { kind: "role", value: { role: "textbox", name: "Email" } },
        target_nth: 2,
        text: "hello",
        span: { start: 0, end: 0, line: 6, col: 5 },
      },
      {
        verb: "drag",
        from: { kind: "role", value: { role: "row", name: "Source" } },
        from_nth: 2,
        to: { kind: "role", value: { role: "row", name: "Destination" } },
        to_nth: 3,
        span: { start: 0, end: 0, line: 7, col: 5 },
      },
    );

    const text = formatEditableStory(story);
    expect(text).toContain('type <textbox> "Email" nth 2 "hello"');
    expect(text).toContain('drag <row> "Source" nth 2 to <row> "Destination" nth 3');
  });

  it("serializes text overlays canonically while preserving step metadata", () => {
    const story = structuredClone(STORY);
    story.scenes[0]?.commands.push({
      verb: "text-overlay",
      text: 'Welcome to "StoryCapture"',
      duration_ms: 2_000,
      span: { start: 0, end: 0, line: 6, col: 5 },
      step_id: "12345678-1234-1234-1234-123456789abc",
    });

    expect(formatEditableStory(story)).toContain(
      'text-overlay "Welcome to \\"StoryCapture\\"" 2000ms  # @id=12345678-1234-1234-1234-123456789abc',
    );
  });

  it("patches commands without mutating the original story", () => {
    const next = patchCommand(STORY, 0, 0, { url: "https://example.org" });
    expect(formatEditableStory(next)).toContain('navigate "https://example.org"');
    const original = STORY.scenes[0]?.commands[0];
    expect(original?.verb).toBe("navigate");
    if (original?.verb === "navigate") {
      expect(original.url).toBe("https://example.com");
    }
  });

  it("stamps a missing step id for polish sidecar keys", () => {
    const { story, stepId } = cloneStoryWithStepId(STORY, 0, 0);
    expect(stepId).toBeTruthy();
    expect(formatEditableStory(story)).toContain(`# @id=${stepId}`);
  });

  it("stamps all missing ids before Record & Polish", () => {
    const { story, changed } = ensureAllStepIds(STORY);
    expect(changed).toBe(true);
    expect(story.scenes[0]?.commands.every((command) => Boolean(command.step_id))).toBe(true);
    expect(ensureAllStepIds(story).changed).toBe(false);
  });

  it("patches picked locators while preserving command values", () => {
    const typeCommand = {
      verb: "type" as const,
      target: { kind: "label" as const, value: "Email" },
      text: "alice@example.com",
      span: { start: 0, end: 0, line: 1, col: 1 },
      step_id: "step-type",
    };
    const patch = updateCommandTargetFromPick(typeCommand, {
      kind: "testid",
      value: "email",
    });
    expect(patch).toEqual({ target: { kind: "test_id", value: "email" } });
    expect(typeCommand.text).toBe("alice@example.com");
  });

  it("only enables picker for target-bearing commands", () => {
    expect(commandSupportsPick(STORY.scenes[0]?.commands[1] as never)).toBe(true);
    expect(commandSupportsPick(STORY.scenes[0]?.commands[0] as never)).toBe(false);
  });

  it("only enables visual focus controls for target-bearing commands", () => {
    expect(commandSupportsVisualFocus(STORY.scenes[0]?.commands[1] as never)).toBe(true);
    expect(commandSupportsVisualFocus(STORY.scenes[0]?.commands[0] as never)).toBe(false);
  });

  it("prunes polish entries for deleted steps and scenes", () => {
    const polish: StoryPolishDoc = {
      version: 2,
      global: {
        recipe: "dynamic",
        autoZoom: "standard",
        actionFocus: "standard",
        autoZoomDurationMs: 800,
        cursor: "smooth",
        cursorSkin: "mac-default",
        cursorSizeScale: 1,
        background: { kind: "gradient", presetId: "runway-dark" },
      },
      scenes: {
        Checkout: { transitionOut: "fade" },
        Deleted: { transitionOut: "fade" },
      },
      steps: {
        "step-buy": { zoom: "strong", callout: "Buy", highlight: true },
        "step-old": { zoom: "standard" },
        "step-empty": {},
      },
    };

    const pruned = prunePolishDocForStory(polish, STORY);
    expect(pruned.changed).toBe(true);
    expect(pruned.removedStepIds).toEqual(["step-old", "step-empty"]);
    expect(pruned.removedSceneNames).toEqual(["Deleted"]);
    expect(Object.keys(pruned.doc.steps)).toEqual(["step-buy"]);
    expect(Object.keys(pruned.doc.scenes)).toEqual(["Checkout"]);
  });

  it("normalizes legacy v1 polish into the v2 sidecar shape", () => {
    const doc = normalizePolishDoc({
      version: 1,
      global: {
        recipe: "dynamic",
        autoZoom: "strong",
        cursor: "hidden",
        background: "dark",
      },
      scenes: {
        Checkout: { transitionOut: "slide-left" },
      },
      steps: {
        "step-buy": { zoom: "strong", callout: "Buy", highlight: true },
      },
    });

    expect(doc.version).toBe(2);
    expect(doc.global.background).toEqual({ kind: "solid", color: "#101218" });
    expect(doc.global.cursorSkin).toBe("mac-default");
    expect(doc.global.actionFocus).toBe("off");
    expect(doc.global.autoZoomDurationMs).toBe(1600);
    expect(doc.steps["step-buy"]?.callout).toBe("Buy");
    expect(doc.steps["step-buy"]?.highlight).toBe(true);
  });

  it("normalizes invalid polish enum values back to safe defaults", () => {
    const doc = normalizePolishDoc({
      global: {
        recipe: "fast",
        autoZoom: "huge",
        actionFocus: "giant",
        cursor: "gone",
        cursorSkin: "triangle",
      },
      scenes: {
        Checkout: { transitionOut: "spin" },
      },
      steps: {
        "step-buy": { zoom: "mega" },
      },
    });

    expect(doc.global.recipe).toBe("dynamic");
    expect(doc.global.autoZoom).toBe("standard");
    expect(doc.global.actionFocus).toBe("off");
    expect(doc.global.cursor).toBe("smooth");
    expect(doc.global.cursorSkin).toBe("mac-default");
    expect(doc.scenes.Checkout?.transitionOut).toBe("none");
    expect(doc.steps["step-buy"]?.zoom).toBe("off");
  });
});

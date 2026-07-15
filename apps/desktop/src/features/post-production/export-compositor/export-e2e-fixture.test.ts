import { describe, expect, it } from "vitest";
import {
  createAllEffectsExportGraph,
  EXPORT_E2E_BACKGROUND_KINDS,
  EXPORT_E2E_CURSOR_TRAJECTORY_KINDS,
  EXPORT_E2E_TRANSITION_KINDS,
  type ExportE2eFixturePaths,
} from "./export-e2e-fixture";
import { CANONICAL_VISUAL_NODE_TYPES, evaluateScene } from "./scene-evaluator";

const paths: ExportE2eFixturePaths = {
  sourceA: "/tmp/source-a.mp4",
  sourceB: "/tmp/source-b.mp4",
  bgm: "/tmp/bgm.wav",
  sfx: "/tmp/sfx.wav",
  voiceover: "/tmp/voiceover.wav",
  actions: "/tmp/actions.json",
  trajectory: "/tmp/trajectory.json",
  cursorPngSequence: "/tmp/cursor-frames",
  backgroundImage: "/tmp/background.png",
};

describe("all-effects export fixture", () => {
  it("covers every canonical visual capability and every audio kind", () => {
    const graph = createAllEffectsExportGraph(paths);
    expect([...new Set(graph.video.map((node) => node.type))].sort()).toEqual(
      [...CANONICAL_VISUAL_NODE_TYPES].sort(),
    );
    expect([...new Set(graph.audio.map((node) => node.kind))].sort()).toEqual([
      "bgm",
      "sfx",
      "voiceover",
    ]);
    expect(() => evaluateScene(graph, 600)).not.toThrow();
  });

  it.each(EXPORT_E2E_TRANSITION_KINDS)("maps transition %s without dropping it", (transition) => {
    const graph = createAllEffectsExportGraph(paths, {
      transition,
      background: "gradient",
      cursorTrajectory: "actions",
    });
    expect(evaluateScene(graph, 850).transition?.kind).toBe(transition);
  });

  it.each(EXPORT_E2E_BACKGROUND_KINDS)("parameterizes %s backgrounds", (background) => {
    const graph = createAllEffectsExportGraph(paths, {
      transition: "fade",
      background,
      cursorTrajectory: "actions",
    });
    expect(evaluateScene(graph, 500).background?.kind.kind).toBe(background);
  });

  it.each(
    EXPORT_E2E_CURSOR_TRAJECTORY_KINDS,
  )("parameterizes %s cursor trajectories", (cursorTrajectory) => {
    const graph = createAllEffectsExportGraph(paths, {
      transition: "fade",
      background: "gradient",
      cursorTrajectory,
    });
    const cursor = graph.video.find((node) => node.type === "cursor-overlay");
    expect(cursor?.trajectory.kind).toBe(cursorTrajectory);
    expect(() => evaluateScene(graph, 500)).not.toThrow();
  });
});

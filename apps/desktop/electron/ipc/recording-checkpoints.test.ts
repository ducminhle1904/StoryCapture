import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkpointStateHash,
  discoverCommittedSceneAttempts,
  RecordingCheckpointCoordinator,
  type SegmentEncoder,
} from "./recording-checkpoints";
import { RecordingMediaClock } from "./recording-media-clock";
import {
  type ParsedCommand,
  type ParsedCommandSceneContext,
  parseStorySource,
} from "./story-parser";

const tempDirs: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-checkpoints-"));
  tempDirs.push(root);
  const segmentsDir = path.join(root, "segments");
  const encoders: Array<{ frames: Uint8Array[]; finished: boolean; aborted: boolean }> = [];
  const coordinator = new RecordingCheckpointCoordinator({
    sessionId: "checkpoint-test",
    segmentsDir,
    width: 2,
    height: 2,
    fps: 30,
    declareArtifacts: async () => {},
    encoderFactory: ({ partialPath, finalPath }): SegmentEncoder => {
      const state = { frames: [] as Uint8Array[], finished: false, aborted: false };
      encoders.push(state);
      return {
        write: async (frame) => {
          state.frames.push(Uint8Array.from(frame));
        },
        finish: async () => {
          state.finished = true;
          await fs.mkdir(path.dirname(finalPath), { recursive: true });
          await fs.writeFile(
            partialPath,
            Buffer.concat(state.frames.map((frame) => Buffer.from(frame))),
          );
          await fs.rename(partialPath, finalPath);
        },
        abort: async () => {
          state.aborted = true;
          await fs.rm(partialPath, { force: true });
        },
      };
    },
  });
  return { root, segmentsDir, coordinator, encoders };
}

function context(sceneId = "scene_test", sceneOrdinal = 1): ParsedCommandSceneContext {
  return {
    scene_id: sceneId,
    scene_name: `Scene ${sceneOrdinal}`,
    scene_ordinal: sceneOrdinal,
    step_ordinal: 1,
  };
}

function command(scene = context()): ParsedCommand {
  return {
    verb: "click",
    step_id: "step-1",
    target: { kind: "label", value: "Save" },
    ...scene,
  } as ParsedCommand;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("hybrid recording checkpoints", () => {
  it("keeps scene identity stable across command edits and changes it on rename or reorder", () => {
    const base = parseStorySource(`story "Demo" {
scene "One" {
  click label "Save"
}
scene "Two" {
  wait 100ms
}
}`).ast;
    const edited = parseStorySource(`story "Demo" {
scene "One" {
  click label "Save"
  wait 200ms
}
scene "Two" {
  wait 100ms
}
}`).ast;
    const renamed = parseStorySource(`story "Demo" {
scene "Renamed" {
  click label "Save"
}
scene "Two" {
  wait 100ms
}
}`).ast;
    const reordered = parseStorySource(`story "Demo" {
scene "Two" {
  wait 100ms
}
scene "One" {
  click label "Save"
}
}`).ast;

    const baseCommands = base?.scenes.flatMap((scene) => scene.commands) as ParsedCommand[];
    const editedCommands = edited?.scenes.flatMap((scene) => scene.commands) as ParsedCommand[];
    const renamedCommands = renamed?.scenes.flatMap((scene) => scene.commands) as ParsedCommand[];
    const reorderedCommands = reordered?.scenes.flatMap(
      (scene) => scene.commands,
    ) as ParsedCommand[];
    expect(editedCommands[0]?.scene_id).toBe(baseCommands[0]?.scene_id);
    expect(editedCommands[1]?.step_ordinal).toBe(2);
    expect(renamedCommands[0]?.scene_id).not.toBe(baseCommands[0]?.scene_id);
    expect(reorderedCommands[1]?.scene_id).not.toBe(baseCommands[0]?.scene_id);
    expect(
      baseCommands.map(({ scene_ordinal, step_ordinal }) => [scene_ordinal, step_ordinal]),
    ).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("commits immutable scene media and a durable soft checkpoint", async () => {
    const { segmentsDir, coordinator, encoders } = await fixture();
    const scene = context();
    const step = command(scene);
    const master = new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 });
    await coordinator.beginScene(scene);
    coordinator.beginStep(step, master.snapshot());
    const landmark = master.commitFrame(true);
    if (!landmark) throw new Error("expected master landmark");
    await coordinator.recordFrame(new Uint8Array(16).fill(7), landmark);
    const committed = await coordinator.commitStep({
      command: step,
      actionEventId: "step-1:1",
      url: "https://example.test/dashboard?token=secret",
      targetKind: "element",
      health: { frames_dropped: 0, auth_token: "must-not-persist" },
    });
    coordinator.recordAction("step-1:1", {
      step_id: step.step_id ?? null,
      ordinal: 1,
      verb: step.verb,
      t_start_ms: 0,
      t_action_ms: 0,
      t_end_ms: 0,
      target: null,
      secondary_target: null,
      pointer: null,
    });
    const attempt = await coordinator.closeScene("committed", { frames_written: 1 });

    expect(attempt).toMatchObject({
      status: "committed",
      scene_id: scene.scene_id,
      source_frame_range: { start: 0, end: 0 },
      source_pts_range_us: { start: 0, end: 0 },
    });
    expect(encoders[0]).toMatchObject({ finished: true, aborted: false });
    expect(committed.checkpoint).toMatchObject({
      frame_range: { start: 0, end: 0 },
      pts_range_us: { start: 0, end: 0 },
      status: "succeeded",
    });
    expect(committed.checkpoint.state_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(coordinator.liveState(committed.live.live_state_handle)).toEqual(committed.live);
    expect(coordinator.assemblySnapshot()).toMatchObject({
      attempts: [{ attempt_id: attempt?.attempt_id }],
      checkpoints_by_attempt: {
        [attempt?.attempt_id ?? "missing"]: [{ step_id: step.step_id }],
      },
      actions_by_attempt: {
        [attempt?.attempt_id ?? "missing"]: [{ step_id: step.step_id }],
      },
    });

    const journal = await fs.readFile(path.join(segmentsDir, "checkpoints.v1.jsonl"), "utf8");
    expect(journal).not.toContain("live_state_handle");
    expect(journal).not.toContain("secret");
    expect(journal).not.toContain("auth_token");
    await expect(discoverCommittedSceneAttempts(segmentsDir)).resolves.toHaveLength(1);
  });

  it("creates monotonic immutable attempts and never treats partial or failed media as committed", async () => {
    const { segmentsDir, coordinator, encoders } = await fixture();
    const scene = context();
    const master = new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 });

    const first = await coordinator.beginScene(scene);
    await coordinator.closeScene("failed");
    expect(encoders[0]?.aborted).toBe(true);

    const second = await coordinator.beginScene(scene);
    const landmark = master.commitFrame(true);
    if (!landmark) throw new Error("expected master landmark");
    await coordinator.recordFrame(new Uint8Array(16), landmark);
    await coordinator.closeScene("cancelled");
    await fs.writeFile(path.join(segmentsDir, "orphan.mp4.partial"), "partial");

    expect(first.attempt_id).toBe("attempt-000001");
    expect(second.attempt_id).toBe("attempt-000002");
    await expect(discoverCommittedSceneAttempts(segmentsDir)).resolves.toEqual([]);
  });

  it("rejects regressing step media ranges", async () => {
    const { coordinator } = await fixture();
    const scene = context();
    const step = command(scene);
    await coordinator.beginScene(scene);
    coordinator.beginStep(step, {
      clock: "encoded_video_pts",
      unit: "us",
      originFrame: 0,
      state: "running",
      fpsNum: 30,
      fpsDen: 1,
      frameCount: 5,
      nextFrameIndex: 5,
      nextPtsUs: 166_667,
      durationUs: 166_667,
    });
    await coordinator.recordFrame(new Uint8Array(16), { frameIndex: 4, ptsUs: 133_333 });
    await expect(coordinator.commitStep({ command: step, actionEventId: null })).rejects.toThrow(
      "checkpoint_clock_regressed",
    );
    await coordinator.closeScene("failed");
  });

  it("hashes only sanitized URL identity and invalidates live handles", async () => {
    const shared = {
      sceneId: "scene",
      stepId: "step",
      verb: "click",
      targetKind: "element",
      frame: 1,
      ptsUs: 33_333,
    };
    expect(checkpointStateHash({ ...shared, url: "https://example.test/path?token=one" })).toBe(
      checkpointStateHash({ ...shared, url: "https://example.test/path?token=two" }),
    );
    expect(checkpointStateHash({ ...shared, url: "https://example.test/other" })).not.toBe(
      checkpointStateHash({ ...shared, url: "https://example.test/path" }),
    );

    const { coordinator } = await fixture();
    const scene = context();
    const step = command(scene);
    const master = new RecordingMediaClock({ fpsNum: 30, fpsDen: 1 });
    await coordinator.beginScene(scene);
    coordinator.beginStep(step, master.snapshot());
    const landmark = master.commitFrame(true);
    if (!landmark) throw new Error("expected landmark");
    await coordinator.recordFrame(new Uint8Array(16), landmark);
    const { live } = await coordinator.commitStep({ command: step, actionEventId: null });
    coordinator.invalidateLiveState();
    expect(coordinator.liveState(live.live_state_handle)).toBeNull();
    await coordinator.closeScene("committed");
  });
});

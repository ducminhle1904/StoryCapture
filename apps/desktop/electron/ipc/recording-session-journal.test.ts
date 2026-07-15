import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingBundleWriter, readRecordingBundleManifest } from "./recording-bundle";
import { RecordingSessionJournalStore } from "./recording-session-journal";

const roots: string[] = [];
const validProbe = async () => ({
  status: "valid" as const,
  duration_ms: 1000,
  width: 1280,
  height: 720,
  codec: "h264",
  container: "mov,mp4",
});

async function fixture() {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-journal-project-"));
  const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-journal-store-"));
  roots.push(project, journalRoot);
  const writer = await RecordingBundleWriter.allocate("session-1", project, {
    probe: validProbe,
  });
  const store = new RecordingSessionJournalStore({
    root: journalRoot,
    mode: "manual",
    probe: validProbe,
  });
  const journal = await store.createForBundle(writer.allocation, {
    target_kind: "author_preview",
    width: 1280,
    height: 720,
    output_width: 1280,
    output_height: 720,
    requested_fps: 30,
  });
  return { project, journalRoot, writer, store, journal };
}

async function simulateRestart(
  journalRoot: string,
  journalId: string,
  recoveryState?: "recovering" | "discarding",
): Promise<void> {
  const file = path.join(journalRoot, `${journalId}.json`);
  const journal = JSON.parse(await fs.readFile(file, "utf8"));
  journal.host_pid = process.pid + 1000;
  if (recoveryState) journal.recovery_state = recoveryState;
  await fs.writeFile(file, `${JSON.stringify(journal, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("RecordingSessionJournalStore", () => {
  it("indexes interrupted journals read-only and excludes current-host sessions", async () => {
    const { journalRoot, store, journal } = await fixture();
    expect((await store.list({ version: 1 })).recordings).toEqual([]);
    await simulateRestart(journalRoot, journal.journal_id);
    const file = path.join(journalRoot, `${journal.journal_id}.json`);
    const before = await fs.stat(file);
    const restarted = new RecordingSessionJournalStore({
      root: journalRoot,
      mode: "observe",
      probe: validProbe,
    });
    expect(await restarted.list({ version: 1 })).toMatchObject({
      version: 1,
      recordings: [{ journal_id: journal.journal_id, checkpoint: "bundle_allocated" }],
    });
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("recovers an already-readable staged video as a repairable canonical bundle", async () => {
    const { journalRoot, writer, store, journal } = await fixture();
    await fs.writeFile(writer.allocation.stagingVideoPath, "video");
    await store.checkpoint("session-1", "media_durable", {
      artifacts: [{ kind: "video", file: writer.allocation.stagingVideoPath }],
      capture: { observed_fps: 30, frames_written: 30 },
    });
    await simulateRestart(journalRoot, journal.journal_id);
    const restarted = new RecordingSessionJournalStore({
      root: journalRoot,
      mode: "manual",
      probe: validProbe,
    });
    const request = {
      version: 1,
      journal_id: journal.journal_id,
      request_id: "recover-1",
    };
    const first = await restarted.recover(request);
    expect(first).toMatchObject({
      verdict: "repairable",
      output_path: writer.allocation.finalVideoPath,
      cached: false,
    });
    expect((await readRecordingBundleManifest(writer.allocation.finalRoot))?.outcome).toMatchObject(
      {
        verdict: "repairable",
        reason_code: "recovery_salvaged",
      },
    );
    expect(await restarted.recover({ ...request, request_id: "recover-2" })).toMatchObject({
      ...first,
      cached: true,
    });
    const afterSecondRestart = new RecordingSessionJournalStore({
      root: journalRoot,
      mode: "manual",
      probe: validProbe,
    });
    expect(await afterSecondRestart.recover({ ...request, request_id: "recover-3" })).toMatchObject(
      {
        ...first,
        cached: true,
      },
    );
  });

  it("lists and retries stale recovering and discarding transitions", async () => {
    const recovering = await fixture();
    await fs.writeFile(recovering.writer.allocation.stagingVideoPath, "video");
    await recovering.store.checkpoint("session-1", "media_durable", {
      artifacts: [{ kind: "video", file: recovering.writer.allocation.stagingVideoPath }],
      capture: { observed_fps: 30, frames_written: 30 },
    });
    await simulateRestart(recovering.journalRoot, recovering.journal.journal_id, "recovering");
    const restartedRecovery = new RecordingSessionJournalStore({
      root: recovering.journalRoot,
      mode: "manual",
      probe: validProbe,
    });
    expect((await restartedRecovery.list({ version: 1 })).recordings).toEqual([
      expect.objectContaining({ journal_id: recovering.journal.journal_id }),
    ]);
    await expect(
      restartedRecovery.recover({
        version: 1,
        journal_id: recovering.journal.journal_id,
        request_id: "retry-recovering",
      }),
    ).resolves.toMatchObject({ verdict: "repairable", cached: false });

    const discarding = await fixture();
    await fs.writeFile(discarding.writer.allocation.stagingVideoPath, "video");
    await discarding.store.checkpoint("session-1", "media_durable", {
      artifacts: [{ kind: "video", file: discarding.writer.allocation.stagingVideoPath }],
    });
    await simulateRestart(discarding.journalRoot, discarding.journal.journal_id, "discarding");
    const restartedDiscard = new RecordingSessionJournalStore({
      root: discarding.journalRoot,
      mode: "manual",
      probe: validProbe,
    });
    expect((await restartedDiscard.list({ version: 1 })).recordings).toEqual([
      expect.objectContaining({ journal_id: discarding.journal.journal_id }),
    ]);
    await expect(
      restartedDiscard.discard({
        version: 1,
        journal_id: discarding.journal.journal_id,
        request_id: "retry-discarding",
      }),
    ).resolves.toMatchObject({ discarded: true, cached: false });
  });

  it("reconstructs a recovery receipt after publication won the crash race", async () => {
    const { journalRoot, writer, store, journal } = await fixture();
    await fs.writeFile(writer.allocation.stagingVideoPath, "video");
    await store.checkpoint("session-1", "media_durable", {
      artifacts: [{ kind: "video", file: writer.allocation.stagingVideoPath }],
      capture: { observed_fps: 30, frames_written: 30 },
    });
    await store.recover({
      version: 1,
      journal_id: journal.journal_id,
      request_id: "publish-before-crash",
    });
    const journalFile = path.join(journalRoot, `${journal.journal_id}.json`);
    const interrupted = JSON.parse(await fs.readFile(journalFile, "utf8"));
    interrupted.host_pid = process.pid + 1000;
    interrupted.recovery_state = "recovering";
    interrupted.receipt = null;
    interrupted.receipt_expires_at = null;
    await fs.writeFile(journalFile, `${JSON.stringify(interrupted, null, 2)}\n`);

    const restarted = new RecordingSessionJournalStore({
      root: journalRoot,
      mode: "manual",
      probe: validProbe,
    });
    expect((await restarted.list({ version: 1 })).recordings).toHaveLength(1);
    const recovered = await restarted.recover({
      version: 1,
      journal_id: journal.journal_id,
      request_id: "reconcile-published",
    });
    expect(recovered).toMatchObject({
      verdict: "repairable",
      output_path: writer.allocation.finalVideoPath,
      cached: false,
    });
    await expect(
      restarted.recover({
        version: 1,
        journal_id: journal.journal_id,
        request_id: "replay-reconciled",
      }),
    ).resolves.toMatchObject({ ...recovered, cached: true });
  });

  it("publishes segment-only evidence as failed without stitching", async () => {
    const { writer, store, journal } = await fixture();
    const segment = path.join(writer.allocation.segmentsDir, "scene-1.mp4");
    await fs.writeFile(segment, "segment");
    await store.checkpoint("session-1", "media_durable", {
      artifacts: [{ kind: "segment", file: segment }],
    });
    const result = await store.recover({
      version: 1,
      journal_id: journal.journal_id,
      request_id: "recover-segment",
    });
    expect(result).toMatchObject({ verdict: "failed", output_path: null });
    const manifest = await readRecordingBundleManifest(writer.allocation.finalRoot);
    expect(manifest?.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "segment", relative_path: "segments/scene-1.mp4" }),
      ]),
    );
    expect(
      await fs.readFile(path.join(writer.allocation.finalRoot, "segments", "scene-1.mp4"), "utf8"),
    ).toBe("segment");
  });

  it("discards only declared contained files and persists an idempotent receipt", async () => {
    const { writer, store, journal } = await fixture();
    await fs.writeFile(writer.allocation.stagingVideoPath, "video");
    const unknown = path.join(writer.allocation.stagingRoot, "unknown.txt");
    await fs.writeFile(unknown, "keep");
    await store.checkpoint("session-1", "media_durable", {
      artifacts: [{ kind: "video", file: writer.allocation.stagingVideoPath }],
    });
    const request = {
      version: 1,
      journal_id: journal.journal_id,
      request_id: "discard-1",
    };
    expect(await store.discard(request)).toMatchObject({
      discarded: true,
      deleted_artifact_count: 1,
      cached: false,
    });
    expect(await fs.readFile(unknown, "utf8")).toBe("keep");
    expect(await store.discard({ ...request, request_id: "discard-2" })).toMatchObject({
      discarded: true,
      deleted_artifact_count: 1,
      cached: true,
    });
  });

  it("refuses escaped artifacts and serializes opposite recovery decisions", async () => {
    const escaped = await fixture();
    const journalFile = path.join(escaped.journalRoot, `${escaped.journal.journal_id}.json`);
    const raw = JSON.parse(await fs.readFile(journalFile, "utf8"));
    raw.declared_artifacts.push({
      kind: "diagnostic",
      relative_path: "../outside.txt",
      bytes: 1,
      durable: true,
    });
    raw.host_pid = process.pid + 1;
    await fs.writeFile(journalFile, JSON.stringify(raw));
    const unsafe = new RecordingSessionJournalStore({
      root: escaped.journalRoot,
      mode: "manual",
      probe: validProbe,
    });
    await expect(
      unsafe.discard({
        version: 1,
        journal_id: escaped.journal.journal_id,
        request_id: "unsafe",
      }),
    ).rejects.toThrow(/escapes/);

    const race = await fixture();
    await fs.writeFile(race.writer.allocation.stagingVideoPath, "video");
    await race.store.checkpoint("session-1", "media_durable", {
      artifacts: [{ kind: "video", file: race.writer.allocation.stagingVideoPath }],
    });
    const discarded = race.store.discard({
      version: 1,
      journal_id: race.journal.journal_id,
      request_id: "first",
    });
    const recovered = race.store.recover({
      version: 1,
      journal_id: race.journal.journal_id,
      request_id: "second",
    });
    await expect(discarded).resolves.toMatchObject({ discarded: true });
    await expect(recovered).rejects.toThrow(/already resolved by discard/);
  });
});

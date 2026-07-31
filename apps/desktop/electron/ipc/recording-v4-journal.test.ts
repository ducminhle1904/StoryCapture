import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RECORDING_V4_CONTRACT_VERSION,
  type RecordingV4Journal,
} from "@storycapture/shared-types/recording-v4";
import { afterEach, describe, expect, it } from "vitest";

import { RecordingV4JournalStore } from "./recording-v4-journal";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function journal(root: string, sessionId: string): RecordingV4Journal {
  return {
    version: RECORDING_V4_CONTRACT_VERSION,
    session_id: sessionId,
    project_path: root,
    workspace_path: path.join(root, `.${sessionId}.staging`),
    state: "capturing",
    revision: 4,
    helper_pid: 123,
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:01:00.000Z",
    terminal_result: null,
  };
}

describe("Recording V4 journal recovery", () => {
  it("atomically fails interrupted sessions while retaining their staging workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v4-journal-"));
    roots.push(root);
    const store = new RecordingV4JournalStore(path.join(root, "journals"));
    const stale = journal(root, "stale-session");
    await fs.mkdir(stale.workspace_path, { recursive: true });
    await fs.writeFile(path.join(stale.workspace_path, "partial.mp4"), "partial");
    await store.write(stale);

    const records = await store.recoverInterrupted();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "recovered" });
    expect(await store.read(stale.session_id)).toMatchObject({
      state: "failed",
      revision: 5,
      helper_pid: null,
      terminal_result: {
        state: "failed",
        failure_codes: ["journal_recovery_failed"],
      },
    });
    expect(await fs.readFile(path.join(stale.workspace_path, "partial.mp4"), "utf8")).toBe(
      "partial",
    );
  });

  it("retains malformed journals for diagnostics", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycapture-v4-journal-"));
    roots.push(root);
    const journalRoot = path.join(root, "journals");
    await fs.mkdir(journalRoot, { recursive: true });
    const malformed = path.join(journalRoot, "broken.json");
    await fs.writeFile(malformed, "{not-json", "utf8");

    const records = await new RecordingV4JournalStore(journalRoot).recoverInterrupted();

    expect(records).toEqual([{ journal_path: malformed, journal: null, status: "invalid" }]);
    expect(await fs.readFile(malformed, "utf8")).toBe("{not-json");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import {
  RECORDING_V4_CONTRACT_VERSION,
  RECORDING_V4_PROFILE,
  type RecordingV4Journal,
  type RecordingV4Result,
  readRecordingV4Journal,
} from "@storycapture/shared-types/recording-v4";

import { writeJsonAtomic } from "./json-store";

const JOURNAL_SUFFIX = ".json";

export interface RecordingV4RecoveryRecord {
  journal_path: string;
  journal: RecordingV4Journal | null;
  status: "recovered" | "already_terminal" | "invalid";
}

function failedRecoveryResult(sessionId: string): RecordingV4Result {
  return {
    version: RECORDING_V4_CONTRACT_VERSION,
    profile: RECORDING_V4_PROFILE,
    session_id: sessionId,
    state: "failed",
    bundle_path: null,
    output_path: null,
    diagnostic_bundle_path: null,
    failure_codes: ["journal_recovery_failed"],
  };
}

export class RecordingV4JournalStore {
  constructor(readonly rootPath: string) {}

  pathFor(sessionId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      throw new Error("Invalid Recording V4 session ID.");
    }
    return path.join(this.rootPath, `${sessionId}${JOURNAL_SUFFIX}`);
  }

  async write(journal: RecordingV4Journal): Promise<void> {
    const validated = readRecordingV4Journal(journal);
    if (!validated) throw new Error("Refusing to persist an invalid Recording V4 journal.");
    await writeJsonAtomic(this.pathFor(journal.session_id), validated);
  }

  async read(sessionId: string): Promise<RecordingV4Journal | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.pathFor(sessionId), "utf8")) as unknown;
      return readRecordingV4Journal(value);
    } catch {
      return null;
    }
  }

  async recoverInterrupted(): Promise<RecordingV4RecoveryRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records: RecordingV4RecoveryRecord[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(JOURNAL_SUFFIX)) continue;
      const journalPath = path.join(this.rootPath, entry);
      let journal: RecordingV4Journal | null = null;
      try {
        journal = readRecordingV4Journal(
          JSON.parse(await fs.readFile(journalPath, "utf8")) as unknown,
        );
      } catch {
        // Invalid journal bytes are retained for diagnostics.
      }
      if (!journal) {
        records.push({ journal_path: journalPath, journal: null, status: "invalid" });
        continue;
      }
      if (journal.terminal_result) {
        records.push({ journal_path: journalPath, journal, status: "already_terminal" });
        continue;
      }

      const recovered: RecordingV4Journal = {
        ...journal,
        state: "failed",
        revision: journal.revision + 1,
        helper_pid: null,
        updated_at: new Date().toISOString(),
        terminal_result: failedRecoveryResult(journal.session_id),
      };
      await this.write(recovered);
      records.push({ journal_path: journalPath, journal: recovered, status: "recovered" });
    }
    return records;
  }
}

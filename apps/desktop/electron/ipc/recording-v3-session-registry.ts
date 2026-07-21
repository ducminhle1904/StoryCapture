import type {
  RecordingFailureCodeV3,
  RecordingHostLifecycleV3,
  RecordingHostSessionSnapshotV3,
  RecordingPreflightV3Dto,
  RecordingResultV3,
} from "@storycapture/shared-types/recording-v2";

export interface RecordingV3CoordinatorSession {
  id: string;
  projectFolder: string;
  startedAt: number;
  preflight: RecordingPreflightV3Dto;
}

export class RecordingV3HostSessionRegistry<TSession extends RecordingV3CoordinatorSession> {
  private readonly sessions = new Map<string, TSession>();
  private readonly snapshots = new Map<string, RecordingHostSessionSnapshotV3>();

  constructor(private readonly now = () => new Date().toISOString()) {}

  register(session: TSession): RecordingHostSessionSnapshotV3 {
    if (this.sessions.has(session.id)) throw new Error(`Recording V3 session ${session.id} exists`);
    this.sessions.set(session.id, session);
    const snapshot = this.makeSnapshot(session, "recording", null, [], null);
    this.snapshots.set(session.id, snapshot);
    return snapshot;
  }

  session(id: string): TSession | null {
    return this.sessions.get(id) ?? null;
  }

  snapshot(id: string): RecordingHostSessionSnapshotV3 | null {
    return this.snapshots.get(id) ?? null;
  }

  query(projectFolder: string): RecordingHostSessionSnapshotV3[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.project_folder === projectFolder)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  updateLifecycle(id: string, lifecycle: RecordingHostLifecycleV3): void {
    const current = this.requireSnapshot(id);
    this.snapshots.set(id, { ...current, lifecycle, updated_at: this.now() });
  }

  complete(id: string, result: RecordingResultV3): RecordingHostSessionSnapshotV3 {
    const session = this.requireSession(id);
    const snapshot = this.makeSnapshot(
      session,
      "terminal_unacknowledged",
      result,
      result.status === "quality_failed"
        ? [
            ...new Set([
              ...result.cadence_evidence.failure_codes,
              ...result.quality_evidence.failure_codes,
            ]),
          ]
        : [],
      null,
    );
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  fail(
    id: string,
    failureCodes: RecordingFailureCodeV3[],
    failureMessage: string,
  ): RecordingHostSessionSnapshotV3 {
    const session = this.requireSession(id);
    const snapshot = this.makeSnapshot(
      session,
      "terminal_unacknowledged",
      null,
      [...new Set(failureCodes)],
      failureMessage,
    );
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  acknowledge(id: string): boolean {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.lifecycle !== "terminal_unacknowledged") return false;
    this.snapshots.delete(id);
    this.sessions.delete(id);
    return true;
  }

  private makeSnapshot(
    session: TSession,
    lifecycle: RecordingHostLifecycleV3,
    result: RecordingResultV3 | null,
    failureCodes: RecordingFailureCodeV3[],
    failureMessage: string | null,
  ): RecordingHostSessionSnapshotV3 {
    return {
      version: 3,
      id: session.id,
      project_folder: session.projectFolder,
      started_at_ms: session.startedAt,
      lifecycle,
      preflight: session.preflight,
      result,
      failure_codes: failureCodes,
      failure_message: failureMessage,
      updated_at: this.now(),
    };
  }

  private requireSession(id: string): TSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Recording V3 session ${id} not found`);
    return session;
  }

  private requireSnapshot(id: string): RecordingHostSessionSnapshotV3 {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error(`Recording V3 session ${id} not found`);
    return snapshot;
  }
}

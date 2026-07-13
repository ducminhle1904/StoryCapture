interface OwnedRecordingArgs {
  ownerSessionId: string;
  activeSessionId: string | null;
  completedSessionId: string | null;
}

export function canFinalizeOwnedRecording({
  ownerSessionId,
  activeSessionId,
  completedSessionId,
}: OwnedRecordingArgs): boolean {
  return activeSessionId === ownerSessionId && completedSessionId !== ownerSessionId;
}

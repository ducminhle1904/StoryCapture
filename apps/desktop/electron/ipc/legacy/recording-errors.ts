type RecordingEncoderPhase = "start" | "finalize";

export function recordingErrorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : null;
}

export function recordingEncoderFailure(error: unknown, phase: RecordingEncoderPhase): Error {
  const code = recordingErrorCode(error);
  const action = phase === "start" ? "start" : "finalize the video";
  const wrapped = new Error(`Recording encoder could not ${action}${code ? ` (${code})` : ""}`, {
    cause: error,
  }) as NodeJS.ErrnoException;
  if (code) wrapped.code = code;
  return wrapped;
}

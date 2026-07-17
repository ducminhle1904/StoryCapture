import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const recordingHandlers = legacyHandlers([
  "start_recording",
  "electron_recording_set_audio",
  "stop_recording",
  "pause_recording",
  "resume_recording",
]) satisfies InvokeHandlers;

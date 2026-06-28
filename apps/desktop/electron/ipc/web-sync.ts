import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const webSyncHandlers = legacyHandlers([
  "get_web_account",
  "get_web_api_token",
  "get_sync_status",
  "get_upload_status",
  "start_web_oauth",
  "complete_web_oauth",
  "disconnect_web_account",
  "sync_project_metadata",
  "flush_sync_queue",
  "upload_video",
  "cancel_upload",
  "update_recording_status",
]) satisfies InvokeHandlers;

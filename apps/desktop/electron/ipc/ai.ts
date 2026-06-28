import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const aiHandlers = legacyHandlers([
  "lsp_request",
  "nl_get_session_id",
  "nl_load_history",
  "nl_chat_send",
  "nl_cancel",
  "nl_diff_apply",
  "nl_diff_reject",
  "nl_regen_step",
  "session_get_rollup",
  "tts_voice_list",
  "tts_generate",
  "tts_regenerate_clip",
  "tts_apply_sync",
  "tts_gc_cache",
]) satisfies InvokeHandlers;

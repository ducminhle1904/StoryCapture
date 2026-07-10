export type CursorSyncMode = "legacy" | "shadow" | "unified";

export function resolveCursorSyncMode(
  value = process.env.STORYCAPTURE_CURSOR_SYNC_MODE,
): CursorSyncMode {
  if (value === "legacy" || value === "shadow" || value === "unified") return value;
  return "shadow";
}

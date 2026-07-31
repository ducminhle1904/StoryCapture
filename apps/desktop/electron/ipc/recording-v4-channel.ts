import type { WebContents } from "electron";

export function recordingV4ChannelId(value: unknown): number | null {
  if (typeof value === "string" && value.startsWith("__CHANNEL__:")) {
    const id = Number(value.slice("__CHANNEL__:".length));
    return Number.isFinite(id) ? id : null;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = Number((value as { id?: unknown }).id);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

export function sendRecordingV4Channel(
  sender: WebContents,
  channelId: number,
  message: unknown,
): void {
  if (!sender.isDestroyed()) sender.send("tauri-channel", { id: channelId, message });
}

export function closeRecordingV4Channel(sender: WebContents, channelId: number): void {
  if (!sender.isDestroyed()) sender.send("tauri-channel", { id: channelId, end: true });
}

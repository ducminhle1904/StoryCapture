const TAURI_INVOKE_ENVELOPE =
  /^Error invoking remote method ['"]tauri-invoke['"]:\s*(?:Error:\s*)?/u;

function readableIpcMessage(message: string): string {
  const readable = message.replace(TAURI_INVOKE_ENVELOPE, "").trim();
  return readable || message;
}

export function formatIpcError(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return readableIpcMessage(error);
  if (error instanceof Error) return readableIpcMessage(error.message);
  if (typeof error === "object") {
    const object = error as Record<string, unknown>;
    if (typeof object.message === "string") {
      const message = readableIpcMessage(object.message);
      return object.kind ? `${object.kind}: ${message}` : message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

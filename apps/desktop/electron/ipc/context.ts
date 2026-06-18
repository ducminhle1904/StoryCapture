import type { IpcMainInvokeEvent } from "electron";
import type { InvokeEnvelope, IpcContext } from "./types";

export function createIpcContext(
  event: IpcMainInvokeEvent,
  envelope: InvokeEnvelope,
  invokeLegacy: IpcContext["invokeLegacy"],
): IpcContext {
  return { event, envelope, invokeLegacy };
}

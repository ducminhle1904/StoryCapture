import type { IpcMainInvokeEvent } from "electron";
import { createIpcContext } from "./context";
import type { InvokeEnvelope, InvokeHandlers } from "./types";

export type LegacyInvokeHandler = (
  event: IpcMainInvokeEvent,
  envelope: InvokeEnvelope,
) => unknown | Promise<unknown>;

export function handleInvoke(
  event: IpcMainInvokeEvent,
  envelope: InvokeEnvelope,
  handlers: InvokeHandlers,
  handleLegacyInvoke: LegacyInvokeHandler,
): unknown | Promise<unknown> {
  const context = createIpcContext(event, envelope, (cmd = envelope.cmd) =>
    handleLegacyInvoke(event, { ...envelope, cmd }),
  );
  const handler = Object.hasOwn(handlers, envelope.cmd) ? handlers[envelope.cmd] : undefined;
  if (handler) return handler(envelope.args, context);
  return context.invokeLegacy();
}

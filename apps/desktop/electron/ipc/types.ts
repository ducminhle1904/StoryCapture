import type { IpcMainInvokeEvent } from "electron";

export type InvokeArgs = Record<string, unknown> | Uint8Array | ArrayBuffer | null | undefined;

export interface InvokeEnvelope {
  cmd: string;
  args?: InvokeArgs;
  options?: { headers?: Record<string, string> };
}

export interface IpcContext {
  event: IpcMainInvokeEvent;
  envelope: InvokeEnvelope;
  invokeLegacy: (cmd?: string) => unknown | Promise<unknown>;
}

export type InvokeHandler = (args: InvokeArgs, context: IpcContext) => unknown | Promise<unknown>;

export type InvokeHandlers = Record<string, InvokeHandler>;

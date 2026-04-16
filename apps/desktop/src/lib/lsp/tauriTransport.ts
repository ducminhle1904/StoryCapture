/**
 * Tauri IPC transport for LSP communication (Plan 03-14, Task 2).
 *
 * Bridges the CodeMirror LSP client to the Rust `lsp_request` Tauri command.
 * JSON-RPC envelopes are marshalled as strings (specta compatibility).
 *
 * Architecture (D-16): NO stdio -- all LSP communication flows through
 * Tauri IPC exclusively.
 */

import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * Transport interface for communicating with the in-process LSP server.
 */
export interface TauriLspTransport {
  /** Send a JSON-RPC request and await the response. */
  sendRequest(method: string, params: unknown): Promise<unknown>;
  /** Send a JSON-RPC notification (no response expected). */
  sendNotification(method: string, params: unknown): void;
  /** Register a handler for server-initiated notifications. Returns unsubscribe function. */
  onNotification(
    handler: (n: { method: string; params: unknown }) => void,
  ): () => void;
  /** Clean up resources (channel, handlers). */
  dispose(): void;
}

/**
 * Create a TauriLspTransport instance for a given document URI.
 *
 * Each transport instance maintains its own Tauri Channel for receiving
 * server-initiated notifications (e.g. publishDiagnostics).
 */
export function createTauriLspTransport(_docUri: string): TauriLspTransport {
  const handlers = new Set<
    (n: { method: string; params: unknown }) => void
  >();
  let disposed = false;

  // Create a Tauri Channel for receiving server notifications.
  const channel = new Channel<{ method: string; params_json: string }>();
  channel.onmessage = (msg) => {
    if (disposed) return;
    const params = JSON.parse(msg.params_json) as unknown;
    const notification = { method: msg.method, params };
    handlers.forEach((h) => h(notification));
  };

  let nextId = 1;

  return {
    async sendRequest(method: string, params: unknown): Promise<unknown> {
      if (disposed) throw new Error("Transport disposed");

      const envelope = {
        jsonrpc: "2.0" as const,
        id: nextId++,
        method,
        params,
      };

      const responseJson = await invoke<string>("lsp_request", {
        jsonrpcRequestJson: JSON.stringify(envelope),
        onNotification: channel,
      });

      const response = JSON.parse(responseJson) as {
        result?: unknown;
        error?: { code: number; message: string };
      };

      if (response.error) {
        throw new Error(response.error.message);
      }

      return response.result;
    },

    sendNotification(method: string, params: unknown): void {
      if (disposed) return;

      const envelope = {
        jsonrpc: "2.0" as const,
        method,
        params,
      };

      // Fire-and-forget: notifications don't expect a response.
      void invoke("lsp_request", {
        jsonrpcRequestJson: JSON.stringify(envelope),
        onNotification: channel,
      });
    },

    onNotification(
      handler: (n: { method: string; params: unknown }) => void,
    ): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    dispose(): void {
      disposed = true;
      handlers.clear();
    },
  };
}

/**
 * Tests for TauriLspTransport.
 *
 * Mocks `@tauri-apps/api/core` to simulate the Tauri IPC layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Tauri API
// ---------------------------------------------------------------------------

// Capture the channel onmessage handler so tests can simulate notifications.
let capturedChannelOnMessage: ((msg: unknown) => void) | null = null;
let invokeHandler: ((cmd: string, args: Record<string, unknown>) => unknown) | null = null;

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel<T> {
    set onmessage(handler: (msg: T) => void) {
      capturedChannelOnMessage = handler as (msg: unknown) => void;
    }
  }

  return {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (invokeHandler) {
        return invokeHandler(cmd, args ?? {});
      }
      return null;
    }),
    Channel: MockChannel,
  };
});

import { createTauriLspTransport } from "./tauriTransport";

describe("TauriLspTransport", () => {
  beforeEach(() => {
    capturedChannelOnMessage = null;
    invokeHandler = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: sendRequest calls invoke('lsp_request', ...) and resolves with response.result
  it("sendRequest calls invoke with JSON-RPC envelope and resolves with result", async () => {
    invokeHandler = (cmd, args) => {
      expect(cmd).toBe("lsp_request");

      // args should have jsonrpcRequestJson as a string
      const envelope = JSON.parse(args.jsonrpcRequestJson as string) as {
        jsonrpc: string;
        id: number;
        method: string;
        params: unknown;
      };
      expect(envelope.jsonrpc).toBe("2.0");
      expect(envelope.method).toBe("initialize");
      expect(typeof envelope.id).toBe("number");
      expect(envelope.params).toEqual({ capabilities: {} });

      // args should have onNotification (the channel)
      expect(args.onNotification).toBeDefined();

      // Return a JSON-stringified response
      return JSON.stringify({
        jsonrpc: "2.0",
        id: envelope.id,
        result: {
          capabilities: {
            hoverProvider: true,
            completionProvider: { triggerCharacters: [" "] },
          },
        },
      });
    };

    const transport = createTauriLspTransport("file:///test.story");
    const result = await transport.sendRequest("initialize", {
      capabilities: {},
    });

    expect(result).toEqual({
      capabilities: {
        hoverProvider: true,
        completionProvider: { triggerCharacters: [" "] },
      },
    });

    transport.dispose();
  });

  // Test 2: Incoming Channel messages fire registered onNotification handlers
  it("incoming channel messages fire onNotification handlers", async () => {
    invokeHandler = () => {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { capabilities: {} },
      });
    };

    const transport = createTauriLspTransport("file:///test.story");

    const receivedNotifications: Array<{
      method: string;
      params: unknown;
    }> = [];
    const unsub = transport.onNotification((n) => {
      receivedNotifications.push(n);
    });

    // Trigger a request to set up the channel
    await transport.sendRequest("initialize", { capabilities: {} });

    // Simulate a server notification via the captured channel handler
    expect(capturedChannelOnMessage).not.toBeNull();

    capturedChannelOnMessage!({
      method: "textDocument/publishDiagnostics",
      params_json: JSON.stringify({
        uri: "file:///test.story",
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            severity: 1,
            message: "unknown verb",
          },
        ],
      }),
    });

    expect(receivedNotifications).toHaveLength(1);
    expect(receivedNotifications[0].method).toBe(
      "textDocument/publishDiagnostics",
    );
    const params = receivedNotifications[0].params as {
      uri: string;
      diagnostics: Array<{ message: string }>;
    };
    expect(params.uri).toBe("file:///test.story");
    expect(params.diagnostics[0].message).toBe("unknown verb");

    unsub();
    transport.dispose();
  });

  // Test: sendRequest throws on error response
  it("sendRequest throws on JSON-RPC error response", async () => {
    invokeHandler = () => {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid Request" },
      });
    };

    const transport = createTauriLspTransport("file:///test.story");

    await expect(
      transport.sendRequest("badMethod", {}),
    ).rejects.toThrow("Invalid Request");

    transport.dispose();
  });

  // Test: sendNotification fires invoke without awaiting response
  it("sendNotification fires invoke without blocking", () => {
    let invokeCalled = false;
    invokeHandler = () => {
      invokeCalled = true;
      return JSON.stringify(null);
    };

    const transport = createTauriLspTransport("file:///test.story");
    transport.sendNotification("textDocument/didOpen", {
      textDocument: { uri: "file:///test.story" },
    });

    // invoke is called (fire-and-forget)
    // We can't strictly assert timing, but we can verify the handler was set up
    expect(invokeCalled).toBe(true);

    transport.dispose();
  });

  // Test: unsubscribe stops notifications
  it("unsubscribe stops notification delivery", async () => {
    invokeHandler = () => {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: null,
      });
    };

    const transport = createTauriLspTransport("file:///test.story");
    const received: string[] = [];

    const unsub = transport.onNotification((n) => {
      received.push(n.method);
    });

    // Trigger to set up channel
    await transport.sendRequest("initialize", { capabilities: {} });

    capturedChannelOnMessage!({
      method: "first",
      params_json: "{}",
    });

    unsub();

    capturedChannelOnMessage!({
      method: "second",
      params_json: "{}",
    });

    expect(received).toEqual(["first"]);

    transport.dispose();
  });

  // Test: dispose prevents further requests
  it("dispose prevents further sendRequest calls", async () => {
    const transport = createTauriLspTransport("file:///test.story");
    transport.dispose();

    await expect(
      transport.sendRequest("initialize", {}),
    ).rejects.toThrow("Transport disposed");
  });
});

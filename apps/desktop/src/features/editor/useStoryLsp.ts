/**
 * React hook for wiring the LSP transport to a CodeMirror editor.
 *
 * Returns a CodeMirror Extension that provides LSP-backed diagnostics, hover,
 * and completion. Handles `textDocument/didOpen` on mount and `didChange` on
 * edits. Cleans up on unmount.
 */

import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";
import { frontendLog } from "@/lib/log";
import { pushLspDiagnostics, storyLanguageExtension } from "@/lib/lsp/storyLanguage";
import { createTauriLspTransport, type TauriLspTransport } from "@/lib/lsp/tauriTransport";

interface UseStoryLspOptions {
  /** Document URI for this editor instance. */
  docUri: string;
  /** Initial document text. */
  initialText: string;
  /** Ref to the CodeMirror EditorView (set after mount). */
  viewRef: React.RefObject<EditorView | null>;
}

interface UseStoryLspResult {
  /** CodeMirror extension to install. */
  extension: Extension;
  /** Notify the LSP of a document change. Call on each edit. */
  notifyDidChange: (newText: string, version: number) => void;
}

/**
 * Wire the in-process LSP to a CodeMirror editor via Tauri IPC.
 *
 * Usage:
 * ```tsx
 * const viewRef = useRef<EditorView | null>(null);
 * const { extension, notifyDidChange } = useStoryLsp({
 *   docUri: "file:///project/demo.story",
 *   initialText: source,
 *   viewRef,
 * });
 * // Pass `extension` to CodeMirror's extensions prop.
 * // Call `notifyDidChange(newText, version)` on edits.
 * ```
 */
export function useStoryLsp({
  docUri,
  initialText,
  viewRef,
}: UseStoryLspOptions): UseStoryLspResult {
  const transportRef = useRef<TauriLspTransport | null>(null);

  // Create the extension (stable across re-renders for a given docUri).
  const extension = useMemo(() => {
    const transport = createTauriLspTransport(docUri);
    transportRef.current = transport;
    return storyLanguageExtension(transport, docUri);
  }, [docUri]);

  // On mount: initialize + didOpen. On unmount: didClose + dispose.
  useEffect(() => {
    const transport = transportRef.current;
    if (!transport) return;

    let disposed = false;

    const init = async () => {
      try {
        // Initialize the LSP server (idempotent if already initialized).
        await transport.sendRequest("initialize", {
          capabilities: {},
        });

        // Send initialized notification.
        transport.sendNotification("initialized", {});

        // Open the document.
        transport.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: docUri,
            languageId: "story",
            version: 1,
            text: initialText,
          },
        });

        // Subscribe to publishDiagnostics to push into CM.
        transport.onNotification((n) => {
          if (disposed) return;
          if (n.method === "textDocument/publishDiagnostics" && viewRef.current) {
            pushLspDiagnostics(
              viewRef.current,
              n.params as {
                uri: string;
                diagnostics: Array<{
                  range: {
                    start: { line: number; character: number };
                    end: { line: number; character: number };
                  };
                  severity?: number;
                  message: string;
                }>;
              },
            );
          }
        });
      } catch (e) {
        // LSP initialization failure is non-fatal -- editor works without LSP.
        frontendLog.warn("useStoryLsp", "LSP init failed (editor falling back to no-LSP mode)", {
          error: e,
          fields: { doc_uri: docUri },
        });
      }
    };

    void init();

    return () => {
      disposed = true;
      // Close the document.
      transport.sendNotification("textDocument/didClose", {
        textDocument: { uri: docUri },
      });
      transport.dispose();
      transportRef.current = null;
    };
  }, [docUri, initialText, viewRef]);

  const notifyDidChange = useMemo(() => {
    return (newText: string, version: number) => {
      const transport = transportRef.current;
      if (!transport) return;

      transport.sendNotification("textDocument/didChange", {
        textDocument: { uri: docUri, version },
        contentChanges: [{ text: newText }],
      });
    };
  }, [docUri]);

  return { extension, notifyDidChange };
}

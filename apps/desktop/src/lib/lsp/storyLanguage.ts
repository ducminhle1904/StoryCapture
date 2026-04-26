/**
 * CodeMirror 6 LSP client extension for Story DSL.
 *
 * Custom adapter covering hover, diagnostics, and completion. The
 * `codemirror-languageserver` package's stdio transport doesn't fit the
 * Tauri IPC bridge, so this adapter owns the transport layer directly.
 *
 * Wires:
 * - Diagnostics: `@codemirror/lint` linter fed by `publishDiagnostics`
 * - Hover: `@codemirror/view` hoverTooltip backed by `textDocument/hover`
 * - Completion: `@codemirror/autocomplete` backed by `textDocument/completion`
 */

import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import {
  hoverTooltip,
  type EditorView,
  type Tooltip,
} from "@codemirror/view";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";

import type { TauriLspTransport } from "./tauriTransport";

// ---------------------------------------------------------------------------
// Diagnostics (publishDiagnostics notification -> CM linter)
// ---------------------------------------------------------------------------

interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

/** Convert LSP severity (1=Error,2=Warning,3=Info,4=Hint) to CM severity. */
function lspSeverityToCm(
  severity: number | undefined,
): CmDiagnostic["severity"] {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    default:
      return "info";
  }
}

/** Convert an LSP position {line,character} to a document offset. */
function posToOffset(
  view: EditorView,
  line: number,
  character: number,
): number {
  const docLine = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
  return Math.min(docLine.from + character, docLine.to);
}

// StateEffect + StateField for pushing diagnostics from the notification handler.
const setLspDiagnostics = StateEffect.define<CmDiagnostic[]>();

const lspDiagnosticsField = StateField.define<CmDiagnostic[]>({
  create() {
    return [];
  },
  update(diags, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLspDiagnostics)) {
        return effect.value;
      }
    }
    return diags;
  },
});

// ---------------------------------------------------------------------------
// Hover (textDocument/hover -> CM hoverTooltip)
// ---------------------------------------------------------------------------

interface LspHoverResult {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

// ---------------------------------------------------------------------------
// Completion (textDocument/completion -> CM autocompletion)
// ---------------------------------------------------------------------------

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  documentation?:
    | string
    | { kind: string; value: string };
}

interface LspCompletionResult {
  items?: LspCompletionItem[];
}

/** Map LSP CompletionItemKind to CM completion type. */
function lspCompletionKindToCm(kind: number | undefined): string {
  switch (kind) {
    case 1:
      return "text";
    case 2:
      return "method";
    case 3:
      return "function";
    case 6:
      return "variable";
    case 14:
      return "keyword";
    default:
      return "text";
  }
}

// ---------------------------------------------------------------------------
// Public: storyLanguageExtension
// ---------------------------------------------------------------------------

/**
 * Create a CodeMirror 6 Extension that wires LSP diagnostics, hover, and
 * completion through the given TauriLspTransport.
 *
 * @param transport - The Tauri IPC transport to the LSP server.
 * @param docUri - The document URI (e.g. "file:///path/to/file.story").
 */
export function storyLanguageExtension(
  transport: TauriLspTransport,
  docUri: string,
): Extension {
  // -- Diagnostics: subscribe to publishDiagnostics notifications ----------
  const diagnosticsLinter = linter(
    (view) => {
      return view.state.field(lspDiagnosticsField);
    },
    { delay: 100 },
  );

  // -- Hover ---------------------------------------------------------------
  const hover = hoverTooltip(
    async (view, pos): Promise<Tooltip | null> => {
      const line = view.state.doc.lineAt(pos);
      const lineNumber = line.number - 1; // 0-based for LSP
      const character = pos - line.from;

      try {
        const result = (await transport.sendRequest("textDocument/hover", {
          textDocument: { uri: docUri },
          position: { line: lineNumber, character },
        })) as LspHoverResult | null;

        if (!result) return null;

        let text = "";
        const contents = result.contents;
        if (typeof contents === "string") {
          text = contents;
        } else if (Array.isArray(contents)) {
          text = contents
            .map((c) => (typeof c === "string" ? c : c.value))
            .join("\n\n");
        } else if (contents && typeof contents === "object") {
          text = contents.value;
        }

        if (!text) return null;

        return {
          pos,
          end: pos,
          above: true,
          create() {
            const dom = document.createElement("div");
            dom.className = "cm-lsp-hover";
            dom.style.padding = "4px 8px";
            dom.style.maxWidth = "400px";
            dom.style.whiteSpace = "pre-wrap";
            dom.textContent = text;
            return { dom };
          },
        };
      } catch {
        return null;
      }
    },
    { hoverTime: 300 },
  );

  // -- Completion ----------------------------------------------------------
  const completion = autocompletion({
    override: [
      async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const pos = ctx.pos;
        const line = ctx.state.doc.lineAt(pos);
        const lineNumber = line.number - 1;
        const character = pos - line.from;

        try {
          const result = (await transport.sendRequest(
            "textDocument/completion",
            {
              textDocument: { uri: docUri },
              position: { line: lineNumber, character },
            },
          )) as LspCompletionResult | LspCompletionItem[] | null;

          if (!result) return null;

          const items: LspCompletionItem[] = Array.isArray(result)
            ? result
            : result.items ?? [];

          if (items.length === 0) return null;

          // Find the word start for the completion range.
          const word = ctx.matchBefore(/[a-zA-Z_][a-zA-Z0-9_-]*/);
          const from = word ? word.from : pos;

          return {
            from,
            options: items.map((item) => ({
              label: item.label,
              type: lspCompletionKindToCm(item.kind),
              detail: item.detail,
              apply: item.insertText ?? item.label,
            })),
          };
        } catch {
          return null;
        }
      },
    ],
  });

  return [lspDiagnosticsField, diagnosticsLinter, hover, completion];
}

/**
 * Push LSP diagnostics into a CodeMirror EditorView.
 *
 * Called by the notification handler when `publishDiagnostics` arrives.
 * Exposed for use by `useStoryLsp` hook.
 */
export function pushLspDiagnostics(
  view: EditorView,
  params: PublishDiagnosticsParams,
): void {
  const cmDiags: CmDiagnostic[] = params.diagnostics.map((d) => {
    const from = posToOffset(
      view,
      d.range.start.line,
      d.range.start.character,
    );
    const to = posToOffset(view, d.range.end.line, d.range.end.character);
    return {
      from: Math.max(0, from),
      to: Math.max(from + 1, to),
      severity: lspSeverityToCm(d.severity),
      message: d.message,
    };
  });

  view.dispatch({
    effects: setLspDiagnostics.of(cmDiags),
  });
}

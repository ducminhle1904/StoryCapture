/**
 * CodeMirror 6 linter extension backed by the host `parse_story` IPC command.
 * Feeds `Diagnostic[]` from `story-parser` back into CM as squiggles + tooltips
 * (UI-02). Debounced 300ms by CM's `linter` helper.
 */

import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";

import { parseStory, type Diagnostic as HostDiagnostic } from "@/ipc/parse";

function toCm(d: HostDiagnostic): CmDiagnostic {
  const severity: CmDiagnostic["severity"] =
    d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info";
  const message = d.suggestion
    ? `${d.message} (did you mean "${d.suggestion}"?)`
    : d.message;
  // Guard against zero-width spans so the squiggle always has a range.
  const from = Math.max(0, Math.floor(d.span.start));
  const to = Math.max(from + 1, Math.floor(d.span.end));
  return { from, to, severity, message };
}

export const storyDiagnosticsLinter = linter(
  async (view) => {
    const source = view.state.doc.toString();
    try {
      const result = await parseStory(source);
      return result.diagnostics.map(toCm);
    } catch (e) {
      // If the host command itself fails, show a single top-of-document info
      // marker so the user knows the linter is offline but don't block typing.
      return [
        {
          from: 0,
          to: Math.max(1, Math.min(80, source.length)),
          severity: "warning",
          message: `DSL linter unavailable: ${String(e)}`,
        },
      ];
    }
  },
  { delay: 300 },
);

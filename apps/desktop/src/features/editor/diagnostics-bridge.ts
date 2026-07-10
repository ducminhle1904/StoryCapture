/** CodeMirror 6 linter backed by the host `parse_story` IPC command. */

import { type Diagnostic as CmDiagnostic, linter } from "@codemirror/lint";

import { type Diagnostic as HostDiagnostic, parseStory } from "@/ipc/parse";

type ByteOffsetMapper = (byteOffset: number) => number;

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}

function createUtf8ByteOffsetMapper(source: string): ByteOffsetMapper {
  const byteOffsets = [0];
  const stringOffsets = [0];
  let bytes = 0;
  let offset = 0;

  for (const char of source) {
    bytes += utf8ByteLength(char.codePointAt(0) ?? 0);
    offset += char.length;
    byteOffsets.push(bytes);
    stringOffsets.push(offset);
  }

  return (byteOffset) => {
    if (!Number.isFinite(byteOffset)) {
      return 0;
    }
    const target = Math.max(0, Math.floor(byteOffset));
    if (target === 0 || source.length === 0) {
      return 0;
    }
    if (target >= bytes) {
      return source.length;
    }

    let low = 0;
    let high = byteOffsets.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (byteOffsets[mid] < target) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    if (byteOffsets[low] === target) {
      return stringOffsets[low];
    }
    return stringOffsets[Math.max(0, low - 1)];
  };
}

function toCm(
  d: HostDiagnostic,
  byteOffsetToStringOffset: ByteOffsetMapper,
  docLength: number,
): CmDiagnostic {
  const severity: CmDiagnostic["severity"] =
    d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info";
  const message = d.suggestion ? `${d.message} (did you mean "${d.suggestion}"?)` : d.message;
  let from = byteOffsetToStringOffset(d.span.start);
  let to = byteOffsetToStringOffset(d.span.end);
  if (docLength > 0 && to <= from) {
    if (from >= docLength) {
      from = docLength - 1;
      to = docLength;
    } else {
      to = from + 1;
    }
  }
  return { from, to, severity, message };
}

export function hostDiagnosticsToCm(source: string, diagnostics: HostDiagnostic[]): CmDiagnostic[] {
  const byteOffsetToStringOffset = createUtf8ByteOffsetMapper(source);
  return diagnostics.map((d) => toCm(d, byteOffsetToStringOffset, source.length));
}

export const storyDiagnosticsLinter = linter(
  async (view) => {
    const source = view.state.doc.toString();
    try {
      const result = await parseStory(source);
      return hostDiagnosticsToCm(source, result.diagnostics);
    } catch (e) {
      // Show a top-of-document marker if the host linter fails.
      return [
        {
          from: 0,
          to: Math.min(80, source.length),
          severity: "warning",
          message: `DSL linter unavailable: ${String(e)}`,
        },
      ];
    }
  },
  { delay: 300 },
);

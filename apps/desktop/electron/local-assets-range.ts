export type ByteRangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

export function parseByteRange(header: string | null, size: number): ByteRangeResult {
  if (header === null) return { kind: "full" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return { kind: "unsatisfiable" };

  const [, startText, endText] = match;
  if (!startText && !endText) return { kind: "unsatisfiable" };

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "unsatisfiable" };
    }
    return {
      kind: "partial",
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= size ||
    requestedEnd < start
  ) {
    return { kind: "unsatisfiable" };
  }

  return { kind: "partial", start, end: Math.min(requestedEnd, size - 1) };
}

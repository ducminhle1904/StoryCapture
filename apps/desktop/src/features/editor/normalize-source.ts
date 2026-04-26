// Trim trailing whitespace per line + ensure one final newline. Files
// without `\n` make zsh's `cat` print a stray `%` marker that alarms users.
export function normalizeForSave(s: string): string {
  const trimmed = s.replace(/[ \t]+$/gm, "").replace(/\n+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

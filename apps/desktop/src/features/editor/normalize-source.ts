/**
 * Strip trailing horizontal whitespace per line, then guarantee exactly one
 * final newline. POSIX text files end with `\n`; without it, terminals
 * render a `%` marker after `cat` which alarms users.
 */
export function normalizeForSave(s: string): string {
  const trimmed = s.replace(/[ \t]+$/gm, "").replace(/\n+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

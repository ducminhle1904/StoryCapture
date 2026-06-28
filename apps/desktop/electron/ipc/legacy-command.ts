import type { InvokeHandlers } from "./types";

export function legacyHandlers(commands: readonly string[]): InvokeHandlers {
  return Object.fromEntries(
    commands.map((cmd) => [cmd, (_args, context) => context.invokeLegacy(cmd)]),
  );
}

import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const secretsHandlers = legacyHandlers([
  "key_get_presence",
  "key_set",
  "key_delete",
  "key_test",
  "store_secret",
  "delete_secret",
  "load_secret",
]) satisfies InvokeHandlers;

import { legacyHandlers } from "../legacy-command";
import type { InvokeHandlers } from "../types";

export const storeHandlers = legacyHandlers([
  "plugin:store|load",
  "plugin:store|get_store",
  "plugin:store|get",
  "plugin:store|set",
  "plugin:store|save",
  "plugin:store|has",
  "plugin:store|delete",
  "plugin:store|clear",
  "plugin:store|reset",
  "plugin:store|keys",
  "plugin:store|values",
  "plugin:store|entries",
  "plugin:store|length",
  "plugin:store|reload",
]) satisfies InvokeHandlers;

import { legacyHandlers } from "./legacy-command";
import type { InvokeHandlers } from "./types";

export const projectsHandlers = legacyHandlers([
  "list_projects",
  "create_project",
  "open_project",
  "remove_project",
  "list_project_recordings",
]) satisfies InvokeHandlers;

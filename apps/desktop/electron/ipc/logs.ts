import fs from "node:fs/promises";
import {
  defaultLogDir,
  exportDiagnosticBundle,
  type FrontendLogPayload,
  getLogConfig,
  type LogConfigUpdate,
  logFromFrontend,
  writeLogConfig,
} from "./log-store";
import type { InvokeHandlers } from "./types";

export const logsHandlers = {
  get_log_config: () => getLogConfig(),
  set_log_config: (args) =>
    writeLogConfig(
      ((args as { config?: LogConfigUpdate } | undefined)?.config ?? {}) as LogConfigUpdate,
    ),
  open_log_dir: async () => {
    const config = await getLogConfig();
    await fs.mkdir(config.effective_log_dir, { recursive: true });
    return config.effective_log_dir;
  },
  log_from_frontend: (args) =>
    logFromFrontend(
      ((args as { payload?: FrontendLogPayload } | undefined)?.payload ?? {}) as FrontendLogPayload,
    ),
  export_diagnostic_bundle: (args) =>
    exportDiagnosticBundle(
      String((args as { parentDir?: string } | undefined)?.parentDir ?? defaultLogDir()),
    ),
} satisfies InvokeHandlers;

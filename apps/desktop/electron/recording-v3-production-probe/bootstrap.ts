import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

const reportPath = process.env.STORYCAPTURE_RECORDING_V3_PROBE_REPORT ?? "";
const runnerModule = "./recording-v3-production-probe-runner.mjs";

process.stderr.write("[recording-v3-bootstrap] module loaded\n");

async function reportBootstrapFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[recording-v3-bootstrap] ${message}\n`);
  if (reportPath) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(
      reportPath,
      `${JSON.stringify({ passed: false, phase: "bootstrap_import", failure: message }, null, 2)}\n`,
    );
  }
}

app.whenReady().then(async () => {
  process.stderr.write("[recording-v3-bootstrap] app ready; importing production runner\n");
  try {
    await import(runnerModule);
  } catch (error) {
    await reportBootstrapFailure(error);
    app.exit(1);
  }
});

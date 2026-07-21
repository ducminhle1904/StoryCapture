import { runRecordingV3CertificationRunner } from "./recording-v3-certification-runner.mjs";

runRecordingV3CertificationRunner({
  defaultDurationSeconds: 600,
  runnerKind: "protected-release-10-minute",
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

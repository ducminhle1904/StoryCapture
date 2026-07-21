import { runRecordingV3CertificationRunner } from "./recording-v3-certification-runner.mjs";

runRecordingV3CertificationRunner({
  defaultDurationSeconds: 60,
  runnerKind: "nightly-60-second",
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

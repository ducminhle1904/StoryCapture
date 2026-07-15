import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key}`);
    values.set(key, value);
  }
  const input = values.get("--input");
  const output = values.get("--output");
  if (!input || !output) throw new Error("--input and --output are required");
  return { input: path.resolve(input), output: path.resolve(output) };
}

function format(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "n/a";
}

function markdownCell(value) {
  return String(value ?? "n/a")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function protocolPayload(run) {
  return run?.protocol?.type === "result" ? run.protocol.payload : null;
}

function protocolFailure(run) {
  return run?.protocol?.type === "failure" ? run.protocol.payload : null;
}

function videoGate(run) {
  const payload = protocolPayload(run);
  if (!payload) {
    return {
      pass: false,
      reasons: [
        run?.timed_out
          ? `timeout after ${run.timeout_ms} ms`
          : (protocolFailure(run)?.reason ?? "no result"),
      ],
    };
  }
  const frameCount = Number(payload.frame_count ?? 0);
  const missing = Number(payload.dropped_or_missing_frames ?? 0);
  const ratio = frameCount + missing > 0 ? missing / (frameCount + missing) : 1;
  const reasons = [];
  if (frameCount <= 0) reasons.push("no frames");
  if (Number(payload.non_monotonic_pts ?? 0) !== 0) reasons.push("non-monotonic PTS");
  if (ratio >= 0.001) reasons.push(`drop+missing ${(ratio * 100).toFixed(4)}%`);
  if (Number(payload.first_frame_delay_ms ?? Infinity) > 3000) reasons.push("first frame >3000 ms");
  if (payload.terminal_reason) reasons.push(`terminal ${payload.terminal_reason}`);
  return { pass: reasons.length === 0, reasons, ratio, payload };
}

function audioGate(run) {
  const payload = protocolPayload(run);
  const audio = payload?.audio;
  if (!payload || !audio)
    return {
      pass: false,
      reasons: [
        run?.timed_out
          ? `timeout after ${run.timeout_ms} ms`
          : (protocolFailure(run)?.reason ?? "no audio result"),
      ],
    };
  const reasons = [];
  if (Number(audio.bufferCount ?? audio.buffer_count ?? 0) <= 0) reasons.push("no audio buffers");
  if (Number(audio.nonMonotonicPTS ?? audio.non_monotonic_pts ?? 0) !== 0) {
    reasons.push("non-monotonic audio PTS");
  }
  if (Number(audio.firstSampleDelayMS ?? audio.first_sample_delay_ms ?? Infinity) > 3000) {
    reasons.push("first audio sample >3000 ms");
  }
  if (!String(audio.writerStatus ?? audio.writer_status ?? "").startsWith("completed")) {
    reasons.push(`writer ${audio.writerStatus ?? audio.writer_status ?? "missing"}`);
  }
  if (run.audio_probe?.status !== "valid" || !run.audio_probe?.has_audio) {
    reasons.push("audio artifact is not probeable");
  }
  return { pass: reasons.length === 0, reasons, payload, audio };
}

function commandList(raw) {
  const commands = [];
  if (raw.build?.exact_command) commands.push(raw.build.exact_command);
  if (raw.fixture?.exact_command) commands.push(raw.fixture.exact_command);
  for (const entry of raw.results ?? []) {
    for (const candidate of [
      entry.electron,
      entry.host_frames,
      entry.backend_segment,
      entry.result,
    ]) {
      if (candidate?.exact_command) commands.push(candidate.exact_command);
      if (candidate?.segment_probe?.exact_command)
        commands.push(candidate.segment_probe.exact_command);
      if (candidate?.audio_probe?.exact_command) commands.push(candidate.audio_probe.exact_command);
    }
  }
  return commands;
}

function nativeCaptureReport(raw, inputPath) {
  const baselines = raw.results.filter((entry) => entry.matrix === "baseline");
  const required = baselines.filter((entry) => entry.required);
  const lifecycle = raw.results.filter((entry) => entry.matrix === "lifecycle");
  const stress = raw.results.filter((entry) => entry.matrix === "stress");
  const rows = [];
  let requiredProfilesPass = required.length === 2;
  let selectedTransport = null;
  let hostValueGate = true;
  let segmentValueGate = true;

  for (const entry of baselines) {
    const hostGate = videoGate(entry.host_frames);
    const segmentGate = videoGate(entry.backend_segment);
    const segmentProbePass = entry.backend_segment?.segment_probe?.status === "valid";
    const electronStatus = entry.electron?.status ?? "missing";
    const electronCPU = Number(entry.electron?.cpu_p95);
    const hostCPU = Number(entry.host_frames?.cpu_p95);
    const segmentCPU = Number(entry.backend_segment?.cpu_p95);
    const hostImprovement =
      electronStatus === "passed" && electronCPU > 0 ? (electronCPU - hostCPU) / electronCPU : null;
    const segmentImprovement =
      electronStatus === "passed" && electronCPU > 0
        ? (electronCPU - segmentCPU) / electronCPU
        : null;
    hostValueGate &&= hostImprovement != null && hostImprovement >= 0.15;
    segmentValueGate &&= segmentImprovement != null && segmentImprovement >= 0.15;
    if (entry.required) {
      requiredProfilesPass &&= hostGate.pass || (segmentGate.pass && segmentProbePass);
    }
    rows.push(
      `| ${markdownCell(entry.profile)} | ${entry.required ? "yes" : "no"} | ${markdownCell(electronStatus)} | ${hostGate.pass ? "pass" : `fail: ${hostGate.reasons.join(", ")}`} | ${segmentGate.pass && segmentProbePass ? "pass" : `fail: ${[...segmentGate.reasons, ...(segmentProbePass ? [] : ["invalid segment"])].join(", ")}`} | ${format(electronCPU)} | ${format(hostCPU)} | ${format(segmentCPU)} |`,
    );
  }

  if (requiredProfilesPass && hostValueGate) selectedTransport = "host_frames";
  if (requiredProfilesPass && segmentValueGate) selectedTransport ??= "backend_segment";
  const fullDuration = raw.config.durationScale === 1;
  const signingPass = Number(raw.signing?.valid_identity_count ?? 0) > 0;
  const lifecycleByScenario = new Map(lifecycle.map((entry) => [entry.scenario, entry]));
  const passingLifecycleScenario = (scenario) =>
    videoGate(lifecycleByScenario.get(scenario)?.result).pass;
  const lifecycleCoverage = {
    "window-and-display":
      passingLifecycleScenario("window-cursor-on") && passingLifecycleScenario("display-full"),
    "permission-first-run-denial-reset": false,
    "source-close": false,
    "minimize-occlusion": false,
    "resize-retina-1x-2x": false,
    "sleep-wake": false,
    "cursor-on-off":
      passingLifecycleScenario("window-cursor-on") && passingLifecycleScenario("window-cursor-off"),
    "format-color-metadata": lifecycle.some(
      (entry) => (protocolPayload(entry.result)?.observed_formats?.length ?? 0) > 0,
    ),
    "system-audio-coexistence": audioGate(
      lifecycleByScenario.get("window-audio-coexistence")?.result,
    ).pass,
  };
  const missingLifecycleCoverage = Object.entries(lifecycleCoverage)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const lifecyclePass = missingLifecycleCoverage.length === 0;
  const stressPass = stress.length >= 1 && stress.every((entry) => videoGate(entry.result).pass);
  const exactMatrix = required.length === 2 && baselines.some((entry) => entry.profile === "4k30");
  const go = Boolean(
    selectedTransport && fullDuration && signingPass && lifecyclePass && stressPass && exactMatrix,
  );
  const blockers = [];
  if (!requiredProfilesPass) blockers.push("mandatory profile media/timestamp gate failed");
  if (!selectedTransport) blockers.push("no transport passed the 15% native value gate");
  if (!fullDuration) blockers.push("duration-scale is not 1; this is smoke evidence only");
  if (!signingPass)
    blockers.push("no valid Developer ID signing identity / packaged identity evidence");
  if (!lifecyclePass) {
    blockers.push(`lifecycle evidence missing or failed: ${missingLifecycleCoverage.join(", ")}`);
  }
  if (!stressPass) blockers.push("ten-minute stress matrix is missing or failed");
  if (!exactMatrix) blockers.push("1080p30, 1440p30, and exploratory 4k30 matrix is incomplete");

  const lines = [
    "# REC-220 macOS Native Capture Spike Report",
    "",
    `- Batch: \`${raw.batch_id}\``,
    `- Created: ${raw.created_at}`,
    `- Raw evidence: \`${inputPath}\``,
    `- Machine: ${raw.machine.arch}, Darwin ${raw.machine.release}`,
    `- Duration scale: ${raw.config.durationScale}`,
    `- Signing identities: ${raw.signing?.valid_identity_count ?? 0}`,
    "",
    "## Paired baseline",
    "",
    "| Profile | Required | Electron | Host frames | Backend segment | Electron CPU p95 | Host CPU p95 | Segment CPU p95 |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Promotion gates",
    "",
    `- Mandatory profiles: ${requiredProfilesPass ? "PASS" : "FAIL"}`,
    `- Native value gate: ${selectedTransport ? `PASS (${selectedTransport})` : "FAIL"}`,
    `- Full planned durations: ${fullDuration ? "PASS" : "FAIL"}`,
    `- Lifecycle matrix: ${lifecyclePass ? "PASS" : "FAIL"}`,
    `- Stress matrix: ${stressPass ? "PASS" : "FAIL"}`,
    `- Signed/package identity: ${signingPass ? "PASS" : "FAIL"}`,
    "",
    "## Blocking evidence",
    "",
    ...(blockers.length ? blockers.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Lifecycle coverage",
    "",
    ...Object.entries(lifecycleCoverage).map(
      ([name, passed]) => `- ${name}: ${passed ? "PASS" : "FAIL"}`,
    ),
    "",
    "## Exact commands",
    "",
    ...commandList(raw).map((command) => `- \`${command.join(" ")}\``),
    "",
    "## References",
    "",
    "- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)",
    "- [Capturing screen content in macOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)",
    "- [SCStreamConfiguration](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration)",
    "",
    go ? `go: ${selectedTransport}` : "no-go",
    "",
  ];
  return { markdown: lines.join("\n"), decision: go ? `go: ${selectedTransport}` : "no-go" };
}

function systemAudioReport(raw, inputPath) {
  const rows = [];
  let capturesPass = raw.results.length >= 3;
  let timingPass = false;
  for (const entry of raw.results) {
    const gate = audioGate(entry.result);
    capturesPass &&= gate.pass;
    const audio = gate.audio;
    const firstPTSNS = audio?.first_pts_ns ?? audio?.firstPTSNS;
    const lastPTSNS = audio?.last_pts_ns ?? audio?.lastPTSNS;
    const spanMS =
      firstPTSNS != null && lastPTSNS != null
        ? (Number(lastPTSNS) - Number(firstPTSNS)) / 1_000_000
        : null;
    const expectedMS = Number(gate.payload?.duration_ms ?? 0);
    const driftMS = spanMS == null ? null : Math.abs(spanMS - expectedMS);
    if (entry.matrix === "timing-10m") timingPass = gate.pass && driftMS != null && driftMS <= 80;
    rows.push(
      `| ${markdownCell(entry.matrix)} | ${gate.pass ? "pass" : `fail: ${gate.reasons.join(", ")}`} | ${gate.audio?.bufferCount ?? gate.audio?.buffer_count ?? 0} | ${format(gate.audio?.firstSampleDelayMS ?? gate.audio?.first_sample_delay_ms)} | ${format(driftMS)} | ${format(entry.result?.cpu_p95)} | ${format(entry.result?.peak_rss_mb)} |`,
    );
  }
  const fullDuration = raw.config.durationScale === 1;
  const signingPass = Number(raw.signing?.valid_identity_count ?? 0) > 0;
  const filterEvidencePass = false;
  const pass = capturesPass && timingPass && fullDuration && signingPass && filterEvidencePass;
  const blockers = [];
  if (!capturesPass) blockers.push("permission/readiness/audio artifact matrix failed");
  if (!timingPass) blockers.push("ten-minute drift evidence is absent or exceeds 80 ms");
  if (!fullDuration) blockers.push("duration-scale is not 1; this is smoke evidence only");
  if (!signingPass) blockers.push("signed/notarized packaged identity evidence is absent");
  if (!filterEvidencePass)
    blockers.push(
      "external marker plus StoryCapture-owned marker exclusion fixture is not yet proven",
    );
  const lines = [
    "# REC-190 macOS System Audio Provider Spike Report",
    "",
    `- Batch: \`${raw.batch_id}\``,
    `- Created: ${raw.created_at}`,
    `- Raw evidence: \`${inputPath}\``,
    `- Machine: ${raw.machine.arch}, Darwin ${raw.machine.release}`,
    `- Duration scale: ${raw.config.durationScale}`,
    `- Signing identities: ${raw.signing?.valid_identity_count ?? 0}`,
    "",
    "## Provider measurements",
    "",
    "| Matrix | Result | Buffers | First sample ms | Drift ms | CPU p95 | Peak RSS MB |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Promotion gates",
    "",
    `- First-buffer/readiness and probeable stem: ${capturesPass ? "PASS" : "FAIL"}`,
    `- Ten-minute drift <=80 ms: ${timingPass ? "PASS" : "FAIL"}`,
    `- Full planned durations: ${fullDuration ? "PASS" : "FAIL"}`,
    `- Signed/package identity: ${signingPass ? "PASS" : "FAIL"}`,
    `- StoryCapture marker exclusion: ${filterEvidencePass ? "PASS" : "FAIL"}`,
    "",
    "## Blocking evidence",
    "",
    ...(blockers.length ? blockers.map((item) => `- ${item}`) : ["- None"]),
    "",
    "## Exact commands",
    "",
    ...commandList(raw).map((command) => `- \`${command.join(" ")}\``),
    "",
    "## References",
    "",
    "- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)",
    "- [SCStreamConfiguration](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration)",
    "",
    pass ? "PASS" : "FAIL",
    "",
  ];
  return { markdown: lines.join("\n"), decision: pass ? "PASS" : "FAIL" };
}

async function main() {
  const { input, output } = parseArgs(process.argv);
  const raw = JSON.parse(await fs.readFile(input, "utf8"));
  if (raw.schema_version !== 1) throw new Error("unsupported spike evidence schema");
  const report =
    raw.kind === "native-capture"
      ? nativeCaptureReport(raw, input)
      : raw.kind === "system-audio"
        ? systemAudioReport(raw, input)
        : null;
  if (!report) throw new Error(`unsupported spike kind: ${raw.kind}`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, report.markdown, "utf8");
  process.stdout.write(`${JSON.stringify({ report_path: output, decision: report.decision })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

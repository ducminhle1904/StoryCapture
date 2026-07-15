#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function usage() {
  return "Usage: diagnose:recording --input <jsonl-file-or-directory> (--session <session-id> | --process) [--json]";
}

function parseArgs(argv) {
  const args = { input: null, session: null, process: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--json") args.json = true;
    else if (value === "--input") {
      index += 1;
      args.input = argv[index] ?? null;
    } else if (value === "--session") {
      index += 1;
      args.session = argv[index] ?? null;
    } else if (value === "--process") {
      args.process = true;
    } else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.input || Boolean(args.session) === args.process) throw new Error(usage());
  return args;
}

async function jsonlFiles(input) {
  const resolved = path.resolve(input);
  const stat = await fs.stat(resolved);
  if (stat.isFile()) return resolved.endsWith(".jsonl") ? [resolved] : [];
  if (!stat.isDirectory()) return [];

  const found = [];
  const visit = async (directory, depth) => {
    if (depth > 3) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (found.length >= 100) throw new Error("input contains more than 100 JSONL files");
        found.push(target);
      } else if (entry.isDirectory()) await visit(target, depth + 1);
    }
  };
  await visit(resolved, 0);
  return found.sort();
}

async function loadEvents(input) {
  const files = await jsonlFiles(input);
  const events = [];
  const parseIssues = [];
  for (const file of files) {
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event && event.schema_version === 1 && typeof event.event === "string") {
          events.push({ ...event, __file: file, __line: index + 1 });
        } else {
          parseIssues.push({
            code: "invalid_schema",
            message: `${path.basename(file)}:${index + 1} is not a v1 recording event`,
          });
        }
      } catch {
        parseIssues.push({
          code: "invalid_json",
          message: `${path.basename(file)}:${index + 1} is not valid JSON`,
        });
      }
    }
  }
  return { events, files, parseIssues };
}

function correlationKey(event, prefix) {
  return [
    prefix,
    event.scene_id ?? "",
    event.step_id ?? "",
    event.attempt_id ?? "",
    event.ordinal ?? "",
  ].join(":");
}

const PHASE_EVENTS = [
  ["recording.drag.started", "recording.drag.completed", "recording.drag.failed", "drag"],
  ["recording.upload.started", "recording.upload.completed", "recording.upload.failed", "upload"],
  [
    "recording.scene.attempt_started",
    "recording.scene.attempt_committed",
    "recording.scene.attempt_failed",
    "scene_attempt",
  ],
  ["recording.stitch.started", "recording.stitch.completed", "recording.stitch.failed", "stitch"],
  ["recording.encoder.started", "recording.encoder.exited", "recording.encoder.exited", "encoder"],
  [
    "recording.backend.spike_started",
    "recording.backend.spike_completed",
    "recording.backend.spike_failed",
    "backend_spike",
  ],
];

function analyzeProcessTrace(rawEvents, files, parseIssues = []) {
  const issues = [...parseIssues];
  const fileReports = files.map((file) => {
    const fileName = path.basename(file);
    const events = rawEvents
      .filter((event) => event.__file === file)
      .sort((left, right) => Number(left.__line) - Number(right.__line));
    const fileIssues = [];
    const sequenceOwners = new Map();
    let previousSequence = 0;
    for (const event of events) {
      const sequence = Number(event.process_sequence);
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        fileIssues.push({
          code: "missing_process_sequence",
          message: `${event.event} has no process sequence`,
        });
        continue;
      }
      if (sequenceOwners.has(sequence)) {
        fileIssues.push({
          code: "duplicate_process_sequence",
          message: `process sequence ${sequence} is used by ${sequenceOwners.get(sequence)} and ${event.event}`,
        });
      }
      sequenceOwners.set(sequence, event.event);
      if (sequence <= previousSequence) {
        fileIssues.push({
          code: "out_of_order_process_sequence",
          message: `${event.event} sequence ${sequence} follows ${previousSequence}`,
        });
      } else if (previousSequence > 0 && sequence > previousSequence + 1) {
        fileIssues.push({
          code: "process_sequence_gap",
          message: `process sequence jumps from ${previousSequence} to ${sequence}`,
        });
      }
      previousSequence = Math.max(previousSequence, sequence);
    }

    const openSpikes = new Map();
    for (const event of events) {
      const key = event.attempt_id ?? event.request_id ?? "unscoped";
      if (event.event === "recording.backend.spike_started") openSpikes.set(key, event);
      if (
        event.event === "recording.backend.spike_completed" ||
        event.event === "recording.backend.spike_failed"
      ) {
        if (!openSpikes.has(key)) {
          fileIssues.push({
            code: "orphan_phase_terminal",
            message: `${event.event} has no matching recording.backend.spike_started`,
          });
        }
        openSpikes.delete(key);
      }
    }
    for (const [key] of openSpikes) {
      fileIssues.push({
        code: "unclosed_phase",
        message: `backend_spike:${key} has no completed or failed event`,
      });
    }
    if (events.length === 0) {
      fileIssues.push({ code: "empty_trace", message: `${fileName} contains no valid events` });
    }
    issues.push(...fileIssues.map((issue) => ({ ...issue, file: fileName })));
    return {
      file: fileName,
      status: fileIssues.length === 0 ? "coherent" : "inconsistent",
      event_count: events.length,
      events: events.map(({ __file, __line, ...event }) => event),
      issues: fileIssues,
    };
  });
  return {
    status: parseIssues.length > 0 ? "invalid" : issues.length === 0 ? "coherent" : "inconsistent",
    mode: "process",
    files: fileReports,
    issues,
  };
}

function analyzeTrace(rawEvents, sessionId, parseIssues = []) {
  const processOrdered = rawEvents
    .filter((event) => event.session_id === sessionId)
    .sort(
      (left, right) =>
        Number(left.process_sequence ?? Number.MAX_SAFE_INTEGER) -
          Number(right.process_sequence ?? Number.MAX_SAFE_INTEGER) ||
        String(left.emitted_at ?? "").localeCompare(String(right.emitted_at ?? "")),
    );
  if (processOrdered.length === 0) {
    return {
      status: "invalid",
      session_id: sessionId,
      events: [],
      issues: [
        ...parseIssues,
        { code: "session_not_found", message: `no structured events for session ${sessionId}` },
      ],
    };
  }

  const issues = [...parseIssues];
  const sequenceOwners = new Map();
  let previousSequence = 0;
  for (const event of processOrdered) {
    const sequence = Number(event.session_sequence);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      issues.push({ code: "missing_sequence", message: `${event.event} has no session sequence` });
      continue;
    }
    if (sequenceOwners.has(sequence)) {
      issues.push({
        code: "duplicate_sequence",
        message: `session sequence ${sequence} is used by ${sequenceOwners.get(sequence)} and ${event.event}`,
      });
    }
    sequenceOwners.set(sequence, event.event);
    if (sequence <= previousSequence) {
      issues.push({
        code: "out_of_order_sequence",
        message: `${event.event} sequence ${sequence} follows ${previousSequence}`,
      });
    } else if (previousSequence > 0 && sequence > previousSequence + 1) {
      issues.push({
        code: "sequence_gap",
        message: `session sequence jumps from ${previousSequence} to ${sequence}`,
      });
    }
    previousSequence = Math.max(previousSequence, sequence);
  }

  const events = [...processOrdered].sort(
    (left, right) => Number(left.session_sequence) - Number(right.session_sequence),
  );
  const createdIndexes = events
    .map((event, index) => (event.event === "recording.session.created" ? index : -1))
    .filter((index) => index >= 0);
  if (createdIndexes.length === 0) {
    issues.push({
      code: "missing_session_created",
      message: "recording.session.created is missing",
    });
  } else if (createdIndexes.length > 1) {
    issues.push({
      code: "duplicate_session_created",
      message: "recording.session.created appears more than once",
    });
  } else if (createdIndexes[0] !== 0) {
    issues.push({
      code: "session_created_not_first",
      message: "recording.session.created is not the first session event",
    });
  }
  const terminalIndex = events.findIndex((event) => event.event === "recording.terminal");
  if (terminalIndex < 0) {
    issues.push({ code: "missing_terminal", message: "recording.terminal is missing" });
  } else if (terminalIndex !== events.length - 1) {
    for (const event of events.slice(terminalIndex + 1)) {
      issues.push({
        code: "event_after_terminal",
        message: `${event.event} appears after recording.terminal`,
      });
    }
  }

  const takeIds = [...new Set(events.map((event) => event.take_id).filter(Boolean))];
  if (takeIds.length > 1) {
    issues.push({
      code: "take_mismatch",
      message: `session references multiple takes: ${takeIds.join(", ")}`,
    });
  }

  const openPhases = new Map();
  const phaseDurations = [];
  for (const event of events) {
    for (const [started, completed, failed, prefix] of PHASE_EVENTS) {
      const key = correlationKey(event, prefix);
      if (event.event === started) openPhases.set(key, event);
      if (event.event === completed || event.event === failed) {
        const opened = openPhases.get(key);
        if (opened) {
          const startedAt = Date.parse(opened.emitted_at);
          const endedAt = Date.parse(event.emitted_at);
          phaseDurations.push({
            phase: prefix,
            key,
            started_sequence: opened.session_sequence,
            ended_sequence: event.session_sequence,
            result: event.event === completed ? "completed" : "failed",
            duration_ms:
              Number.isFinite(startedAt) && Number.isFinite(endedAt)
                ? Math.max(0, endedAt - startedAt)
                : null,
          });
        }
        openPhases.delete(key);
      }
    }
  }
  for (const [key, event] of openPhases) {
    issues.push({
      code: "unclosed_phase",
      message: `${key} opened by ${event.event} was not closed`,
    });
  }

  const lifecycle = events.filter((event) => event.event === "recording.lifecycle.transition");
  const lifecycleDurations = lifecycle.map((event, index) => {
    const next = lifecycle[index + 1];
    const currentTime = Date.parse(event.emitted_at);
    const nextTime = next ? Date.parse(next.emitted_at) : Number.NaN;
    return {
      state: event.phase ?? event.details?.to_state ?? "unknown",
      duration_ms:
        Number.isFinite(currentTime) && Number.isFinite(nextTime)
          ? Math.max(0, nextTime - currentTime)
          : null,
    };
  });
  const healthTransitions = events
    .filter((event) => event.event === "recording.health.state_changed")
    .map((event) => ({
      sequence: event.session_sequence,
      state: event.phase,
      reason: event.reason_code,
    }));
  const reasonCodes = [...new Set(events.map((event) => event.reason_code).filter(Boolean))];
  const artifacts = events
    .filter((event) => event.artifact_relpath)
    .map((event) => ({
      event: event.event,
      path: event.artifact_relpath,
      take_id: event.take_id ?? null,
    }));

  return {
    status: parseIssues.length > 0 ? "invalid" : issues.length === 0 ? "coherent" : "inconsistent",
    session_id: sessionId,
    take_id: takeIds[0] ?? null,
    terminal: terminalIndex >= 0 ? events[terminalIndex] : null,
    lifecycle_durations: lifecycleDurations,
    phase_durations: phaseDurations,
    health_transitions: healthTransitions,
    reason_codes: reasonCodes,
    artifacts,
    events: events.map(({ __file, __line, ...event }) => event),
    issues,
  };
}

function textReport(report) {
  const lines = [
    `Recording trace: ${report.session_id}`,
    `Status: ${report.status}`,
    `Take: ${report.take_id ?? "n/a"}`,
    "",
    "Seq  Time                      Event                                    Phase / reason",
  ];
  for (const event of report.events) {
    lines.push(
      `${String(event.session_sequence ?? "-").padStart(3)}  ${String(event.emitted_at ?? "-").padEnd(24)}  ${event.event.padEnd(40)} ${event.phase ?? event.reason_code ?? ""}`,
    );
  }
  lines.push("", "Phase durations:");
  for (const phase of report.phase_durations ?? []) {
    lines.push(`- ${phase.phase} ${phase.result}: ${phase.duration_ms ?? "n/a"} ms`);
  }
  lines.push("", "Health transitions:");
  for (const health of report.health_transitions ?? []) {
    lines.push(
      `- #${health.sequence} ${health.state ?? "unknown"}${health.reason ? ` (${health.reason})` : ""}`,
    );
  }
  lines.push("", `Reason codes: ${(report.reason_codes ?? []).join(", ") || "none"}`);
  lines.push("", "Artifacts:");
  for (const artifact of report.artifacts ?? []) {
    lines.push(`- ${artifact.event}: ${artifact.path}`);
  }
  lines.push("", `Issues: ${report.issues.length}`);
  for (const issue of report.issues) lines.push(`- ${issue.code}: ${issue.message}`);
  return lines.join("\n");
}

function processTextReport(report) {
  const lines = [`Recording process trace`, `Status: ${report.status}`];
  for (const file of report.files) {
    lines.push("", `${file.file}: ${file.status}`);
    for (const event of file.events) {
      lines.push(
        `${String(event.process_sequence ?? "-").padStart(3)}  ${String(event.emitted_at ?? "-").padEnd(24)}  ${event.event.padEnd(40)} ${event.phase ?? event.reason_code ?? ""}`,
      );
    }
  }
  lines.push("", `Issues: ${report.issues.length}`);
  for (const issue of report.issues) {
    lines.push(`- ${issue.code}${issue.file ? ` [${issue.file}]` : ""}: ${issue.message}`);
  }
  return lines.join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const loaded = await loadEvents(args.input);
    if (loaded.files.length === 0) throw new Error("input contains no JSONL log files");
    const report = args.process
      ? analyzeProcessTrace(loaded.events, loaded.files, loaded.parseIssues)
      : analyzeTrace(loaded.events, args.session, loaded.parseIssues);
    process.stdout.write(
      `${args.json ? JSON.stringify(report, null, 2) : args.process ? processTextReport(report) : textReport(report)}\n`,
    );
    process.exitCode = report.status === "coherent" ? 0 : report.status === "invalid" ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 2;
  }
}

await main();

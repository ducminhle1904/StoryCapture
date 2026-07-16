import type {
  ExportCompositionGraphV4,
  ExportIssue,
  ExportPreflightArgs,
  ExportPreflightOutput,
  ExportPreflightResult,
} from "@storycapture/shared-types";

import { analyzeExportPlan, validateExportOutput } from "./export-planning";
import type { ExportOutput } from "./shared";

type ExportPreflightArgsWithDisclosure = ExportPreflightArgs & {
  ai_disclosure?: {
    contains_ai_voiceover: boolean;
    embed_xmp: boolean;
  };
};

function outputIssue(
  outputIndex: number,
  code: string,
  message: string,
  remediation?: string,
): ExportIssue {
  return {
    id: `${code}:${outputIndex}`,
    code,
    severity: "error",
    message,
    remediation,
    output_index: outputIndex,
  };
}

function outputWarning(
  outputIndex: number,
  code: string,
  message: string,
  remediation?: string,
): ExportIssue {
  return {
    id: `${code}:${outputIndex}`,
    code,
    severity: "warning",
    message,
    remediation,
    output_index: outputIndex,
  };
}

function parseCompositionDuration(graphJson: string): number {
  try {
    const graph = JSON.parse(graphJson) as Partial<ExportCompositionGraphV4>;
    return Number.isFinite(graph.duration_ms) ? Math.max(0, graph.duration_ms ?? 0) : 0;
  } catch {
    return 0;
  }
}

export function exportPreflight(args: ExportPreflightArgsWithDisclosure): ExportPreflightResult {
  const issues = [...args.compiler_issues];
  const outputs: ExportPreflightOutput[] = args.outputs.map((candidate, outputIndex) => {
    const output = candidate as ExportOutput;
    const outputIssues: ExportIssue[] = [];
    if (args.ai_disclosure?.embed_xmp && candidate.format.toLowerCase() !== "mp4") {
      outputIssues.push(
        outputWarning(
          outputIndex,
          "output.xmp-mp4-only",
          "Embedded AI-generated voice metadata (XMP) applies only to MP4 output.",
          `The ${candidate.format.toUpperCase()} export will continue without embedded XMP metadata.`,
        ),
      );
    }
    try {
      validateExportOutput(output);
    } catch (error) {
      outputIssues.push(
        outputIssue(
          outputIndex,
          "output.invalid-config",
          error instanceof Error ? error.message : String(error),
          "Review this output's format, resolution, FPS, quality, and encoder options.",
        ),
      );
    }
    if (!outputIssues.some((issue) => issue.severity === "error")) {
      const plan = analyzeExportPlan(args.graph_json, output);
      if (plan.kind === "unsupported") {
        outputIssues.push(
          outputIssue(
            outputIndex,
            "output.unsupported-composition",
            plan.reason,
            "Fix the listed composition issue before starting this output.",
          ),
        );
      }
    }
    issues.push(...outputIssues);
    return {
      output_index: outputIndex,
      format: candidate.format,
      ready: !outputIssues.some((issue) => issue.severity === "error"),
      issues: outputIssues,
    };
  });
  return {
    ready: !issues.some((issue) => issue.severity === "error"),
    composition_duration_ms: parseCompositionDuration(args.graph_json),
    issues,
    outputs,
  };
}

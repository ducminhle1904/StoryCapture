import type { WorkflowState, WorkflowStep, WorkflowType } from "@/ipc/projects";

export interface WorkflowInputSpec {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
}

export interface WorkflowCatalogEntry {
  id: Exclude<WorkflowType, "freestyle">;
  title: string;
  bestFor: string;
  durationTarget: string;
  polishPreset: "dynamic" | "calm" | "minimal" | "dramatic";
  roadmapSteps: Array<{
    id: string;
    title: string;
    sceneName: string;
    notes: string;
    requiredInputs: string[];
  }>;
  requiredInputs: WorkflowInputSpec[];
}

export type WorkflowInputs = Record<string, string>;

const commonInputs: WorkflowInputSpec[] = [
  {
    key: "target_url",
    label: "Target URL",
    placeholder: "https://app.example.com",
  },
  {
    key: "audience",
    label: "Audience",
    placeholder: "Product-qualified leads, new admins, support team...",
  },
];

export const WORKFLOW_CATALOG: WorkflowCatalogEntry[] = [
  {
    id: "product_demo",
    title: "Product Demo",
    bestFor: "Homepage, pitch, customer intro",
    durationTarget: "90-150 sec",
    polishPreset: "dynamic",
    requiredInputs: [
      ...commonInputs,
      { key: "problem", label: "Problem", placeholder: "What friction are you showing?" },
      { key: "result", label: "Result", placeholder: "What should viewers see at the end?" },
      { key: "cta", label: "CTA", placeholder: "Book a demo, start trial, share feedback..." },
    ],
    roadmapSteps: [
      {
        id: "problem",
        title: "Frame the problem",
        sceneName: "Problem",
        notes: "Show the before state or task friction.",
        requiredInputs: ["problem", "audience"],
      },
      {
        id: "workflow",
        title: "Run the core workflow",
        sceneName: "Core Workflow",
        notes: "Capture one complete flow, not every feature.",
        requiredInputs: ["target_url"],
      },
      {
        id: "result",
        title: "Show the result",
        sceneName: "Result",
        notes: "Land on the success state and make the outcome visible.",
        requiredInputs: ["result"],
      },
      {
        id: "cta",
        title: "Close with CTA",
        sceneName: "Next Step",
        notes: "End with a clear action for the viewer.",
        requiredInputs: ["cta"],
      },
    ],
  },
  {
    id: "tutorial",
    title: "Tutorial / How-to",
    bestFor: "Task walkthrough, help center",
    durationTarget: "2-4 min",
    polishPreset: "calm",
    requiredInputs: [
      ...commonInputs,
      { key: "goal", label: "Goal", placeholder: "What will the user complete?" },
      {
        key: "verification",
        label: "Verification",
        placeholder: "What confirms the task worked?",
      },
    ],
    roadmapSteps: [
      {
        id: "goal",
        title: "State the task goal",
        sceneName: "Goal",
        notes: "Set context and prerequisites.",
        requiredInputs: ["goal", "audience"],
      },
      {
        id: "steps",
        title: "Complete the steps",
        sceneName: "Steps",
        notes: "Use the shortest reliable path through the UI.",
        requiredInputs: ["target_url"],
      },
      {
        id: "verify",
        title: "Verify success",
        sceneName: "Verify",
        notes: "Show the final state or output.",
        requiredInputs: ["verification"],
      },
    ],
  },
  {
    id: "feature_launch",
    title: "Feature Launch",
    bestFor: "Changelog, social, release post",
    durationTarget: "60-120 sec",
    polishPreset: "dramatic",
    requiredInputs: [
      ...commonInputs,
      { key: "feature", label: "Feature", placeholder: "Name the shipped capability" },
      { key: "why", label: "Why it matters", placeholder: "The user problem it solves" },
      { key: "cta", label: "CTA", placeholder: "Try it, read docs, upgrade..." },
    ],
    roadmapSteps: [
      {
        id: "new",
        title: "Introduce what is new",
        sceneName: "What Is New",
        notes: "Name the feature and the viewer benefit.",
        requiredInputs: ["feature", "why"],
      },
      {
        id: "before-after",
        title: "Show before / after",
        sceneName: "Before After",
        notes: "Make the improvement visible.",
        requiredInputs: ["target_url"],
      },
      {
        id: "walkthrough",
        title: "Walk through the feature",
        sceneName: "Walkthrough",
        notes: "Capture one or two launch-critical interactions.",
        requiredInputs: ["feature"],
      },
      {
        id: "cta",
        title: "End with launch CTA",
        sceneName: "Launch CTA",
        notes: "Close on the next action.",
        requiredInputs: ["cta"],
      },
    ],
  },
  {
    id: "sales_marketing",
    title: "Sales / Marketing Demo",
    bestFor: "Outbound, landing page, follow-up",
    durationTarget: "90-180 sec",
    polishPreset: "dynamic",
    requiredInputs: [
      ...commonInputs,
      { key: "persona_pain", label: "Persona pain", placeholder: "The buyer's concrete pain" },
      { key: "proof", label: "Proof point", placeholder: "Metric, workflow, or differentiator" },
      { key: "cta", label: "Sales CTA", placeholder: "Book a demo, start trial..." },
    ],
    roadmapSteps: [
      {
        id: "pain",
        title: "Name the buyer pain",
        sceneName: "Buyer Pain",
        notes: "Open with a recognizable workflow problem.",
        requiredInputs: ["persona_pain", "audience"],
      },
      {
        id: "outcome",
        title: "Show the promised outcome",
        sceneName: "Outcome",
        notes: "Move from pain to product result.",
        requiredInputs: ["target_url", "proof"],
      },
      {
        id: "proof",
        title: "Reduce objection",
        sceneName: "Proof",
        notes: "Show a trust signal, control, or concrete proof point.",
        requiredInputs: ["proof"],
      },
      {
        id: "cta",
        title: "Close the sale",
        sceneName: "Sales CTA",
        notes: "Ask for one next action.",
        requiredInputs: ["cta"],
      },
    ],
  },
  {
    id: "support",
    title: "Support / Troubleshooting",
    bestFor: "CS reply, help center",
    durationTarget: "60-180 sec",
    polishPreset: "minimal",
    requiredInputs: [
      ...commonInputs,
      { key: "symptom", label: "Symptom", placeholder: "What issue does the user see?" },
      { key: "resolved_state", label: "Resolved state", placeholder: "What confirms the fix?" },
      { key: "escalation", label: "Escalation", placeholder: "Where should users go if it fails?" },
    ],
    roadmapSteps: [
      {
        id: "symptom",
        title: "Show the symptom",
        sceneName: "Symptom",
        notes: "Start from the state the user recognizes.",
        requiredInputs: ["symptom", "target_url"],
      },
      {
        id: "fix",
        title: "Apply the fix",
        sceneName: "Fix",
        notes: "Capture the exact recovery path.",
        requiredInputs: ["target_url"],
      },
      {
        id: "confirm",
        title: "Confirm resolved",
        sceneName: "Resolved",
        notes: "Show the stable success state.",
        requiredInputs: ["resolved_state"],
      },
      {
        id: "escalate",
        title: "Escalation path",
        sceneName: "Escalate",
        notes: "Tell users what to send support if the issue remains.",
        requiredInputs: ["escalation"],
      },
    ],
  },
  {
    id: "internal_training",
    title: "Internal Training",
    bestFor: "Sales, support, ops SOP",
    durationTarget: "3-6 min",
    polishPreset: "calm",
    requiredInputs: [
      ...commonInputs,
      { key: "role", label: "Role", placeholder: "Support agent, AE, ops coordinator..." },
      { key: "task", label: "Task", placeholder: "The exact SOP this video trains" },
      { key: "mistake", label: "Common mistake", placeholder: "A mistake to call out" },
    ],
    roadmapSteps: [
      {
        id: "context",
        title: "Set role context",
        sceneName: "Context",
        notes: "Name who uses this workflow and when.",
        requiredInputs: ["role", "task"],
      },
      {
        id: "sop",
        title: "Run the SOP",
        sceneName: "SOP",
        notes: "Capture the standard path without shortcuts.",
        requiredInputs: ["target_url"],
      },
      {
        id: "mistakes",
        title: "Flag common mistakes",
        sceneName: "Common Mistakes",
        notes: "Show what to avoid or verify.",
        requiredInputs: ["mistake"],
      },
      {
        id: "checklist",
        title: "Final checklist",
        sceneName: "Checklist",
        notes: "End with the completion criteria.",
        requiredInputs: ["task"],
      },
    ],
  },
  {
    id: "bug_reproduction",
    title: "Bug Reproduction",
    bestFor: "QA, dev handoff",
    durationTarget: "45-120 sec",
    polishPreset: "minimal",
    requiredInputs: [
      ...commonInputs,
      { key: "environment", label: "Environment", placeholder: "Browser, OS, account, build..." },
      { key: "actual", label: "Actual result", placeholder: "What visibly breaks?" },
      { key: "expected", label: "Expected result", placeholder: "What should happen instead?" },
      { key: "impact", label: "Impact", placeholder: "Who is blocked and how severe is it?" },
    ],
    roadmapSteps: [
      {
        id: "environment",
        title: "Capture environment",
        sceneName: "Environment",
        notes: "Show build/account context before repro.",
        requiredInputs: ["environment", "target_url"],
      },
      {
        id: "steps",
        title: "Run minimum repro steps",
        sceneName: "Repro Steps",
        notes: "Use the shortest path that still reproduces the issue.",
        requiredInputs: ["target_url"],
      },
      {
        id: "actual",
        title: "Show actual result",
        sceneName: "Actual Result",
        notes: "Make the failure visible on screen.",
        requiredInputs: ["actual"],
      },
      {
        id: "expected",
        title: "State expected and impact",
        sceneName: "Expected Impact",
        notes: "End with expected behavior and severity.",
        requiredInputs: ["expected", "impact"],
      },
    ],
  },
  {
    id: "documentation",
    title: "Documentation Video",
    bestFor: "Docs, API, CLI guide",
    durationTarget: "2-5 min",
    polishPreset: "minimal",
    requiredInputs: [
      ...commonInputs,
      { key: "objective", label: "Objective", placeholder: "What does this doc page teach?" },
      {
        key: "output",
        label: "Expected output",
        placeholder: "Command result, UI state, API response...",
      },
      { key: "next_step", label: "Next step", placeholder: "Related doc, follow-up workflow..." },
    ],
    roadmapSteps: [
      {
        id: "objective",
        title: "State doc objective",
        sceneName: "Objective",
        notes: "Give the viewer one clear outcome.",
        requiredInputs: ["objective", "audience"],
      },
      {
        id: "path",
        title: "Follow the preferred path",
        sceneName: "Preferred Path",
        notes: "Capture the recommended commands or UI actions.",
        requiredInputs: ["target_url"],
      },
      {
        id: "output",
        title: "Show expected output",
        sceneName: "Expected Output",
        notes: "Verify the result matches the documentation.",
        requiredInputs: ["output"],
      },
      {
        id: "next",
        title: "Point to next step",
        sceneName: "Next Step",
        notes: "Close with related docs or the next workflow.",
        requiredInputs: ["next_step"],
      },
    ],
  },
];

export function getWorkflowEntry(type: WorkflowType): WorkflowCatalogEntry | null {
  if (type === "freestyle") return null;
  return WORKFLOW_CATALOG.find((entry) => entry.id === type) ?? null;
}

export function createWorkflowInputs(entry: WorkflowCatalogEntry): WorkflowInputs {
  return Object.fromEntries(entry.requiredInputs.map((input) => [input.key, ""]));
}

export function buildWorkflowState(entry: WorkflowCatalogEntry): WorkflowState {
  const now = Date.now();
  return {
    version: 1,
    type: entry.id,
    createdAt: now,
    updatedAt: now,
    steps: entry.roadmapSteps.map(
      (step): WorkflowStep => ({
        id: step.id,
        title: step.title,
        status: "drafted",
        sceneName: step.sceneName,
        requiredInputs: step.requiredInputs,
        notes: step.notes,
      }),
    ),
  };
}

export function buildWorkflowStory(
  entry: WorkflowCatalogEntry,
  projectName: string,
  inputs: WorkflowInputs,
): string {
  const title = escapeStoryString(projectName.trim() || entry.title);
  const app = escapeStoryString(inputs.target_url?.trim() || "https://example.com");
  const scenes = entry.roadmapSteps
    .map((step) => {
      const notes = [
        step.notes,
        ...step.requiredInputs
          .map((key) => inputNote(entry, inputs, key))
          .filter((line): line is string => Boolean(line)),
      ];
      return [
        `  scene "${escapeStoryString(step.sceneName)}" {`,
        ...notes.map((note) => `    # ${sanitizeComment(note)}`),
        "    pause",
        "  }",
      ].join("\n");
    })
    .join("\n\n");

  return `story "${title}" {
  meta {
    app: "${app}"
    viewport: desktop
    theme: dark
    speed: 1.0
  }

${scenes}
}
`;
}

function inputNote(
  entry: WorkflowCatalogEntry,
  inputs: WorkflowInputs,
  key: string,
): string | null {
  const value = inputs[key]?.trim();
  if (!value) return null;
  const spec = entry.requiredInputs.find((input) => input.key === key);
  return `${spec?.label ?? key}: ${value}`;
}

function escapeStoryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sanitizeComment(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

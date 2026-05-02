import { PrismaClient } from "../src/generated/prisma";
import { slugify } from "../src/lib/slugify";

const prisma = new PrismaClient();

const workflowSpecs = [
  {
    name: "Product Demo Roadmap",
    description: "Problem, core workflow, result, and CTA for a focused product demo.",
    category: "SAAS_ONBOARDING",
    workflowType: "PRODUCT_DEMO",
    bestFor: "Homepage, pitch, customer intro",
    durationTarget: "90-150 sec",
    polishPreset: "dynamic",
    scenes: ["Problem", "Core Workflow", "Result", "Next Step"],
    requiredInputs: ["target_url", "audience", "problem", "result", "cta"],
  },
  {
    name: "Tutorial Roadmap",
    description: "Goal, shortest reliable procedure, and verification for a how-to video.",
    category: "API_WALKTHROUGH",
    workflowType: "TUTORIAL",
    bestFor: "Task walkthrough, help center",
    durationTarget: "2-4 min",
    polishPreset: "calm",
    scenes: ["Goal", "Steps", "Verify"],
    requiredInputs: ["target_url", "audience", "goal", "verification"],
  },
  {
    name: "Feature Launch Roadmap",
    description: "Introduce a new feature with before-after proof and a launch CTA.",
    category: "FEATURE_ANNOUNCEMENT",
    workflowType: "FEATURE_LAUNCH",
    bestFor: "Changelog, social, release post",
    durationTarget: "60-120 sec",
    polishPreset: "dramatic",
    scenes: ["What Is New", "Before After", "Walkthrough", "Launch CTA"],
    requiredInputs: ["target_url", "audience", "feature", "why", "cta"],
  },
  {
    name: "Sales Demo Roadmap",
    description: "Buyer pain, promised outcome, proof, and sales CTA.",
    category: "LANDING_PAGE",
    workflowType: "SALES_MARKETING",
    bestFor: "Outbound, landing page, follow-up",
    durationTarget: "90-180 sec",
    polishPreset: "dynamic",
    scenes: ["Buyer Pain", "Outcome", "Proof", "Sales CTA"],
    requiredInputs: ["target_url", "audience", "persona_pain", "proof", "cta"],
  },
  {
    name: "Support Troubleshooting Roadmap",
    description: "Symptom, fix path, resolved state, and escalation guidance.",
    category: "INTERNAL_TRAINING",
    workflowType: "SUPPORT",
    bestFor: "CS reply, help center",
    durationTarget: "60-180 sec",
    polishPreset: "minimal",
    scenes: ["Symptom", "Fix", "Resolved", "Escalate"],
    requiredInputs: ["target_url", "audience", "symptom", "resolved_state", "escalation"],
  },
  {
    name: "Internal Training Roadmap",
    description: "Role context, SOP run, common mistakes, and completion checklist.",
    category: "INTERNAL_TRAINING",
    workflowType: "INTERNAL_TRAINING",
    bestFor: "Sales, support, ops SOP",
    durationTarget: "3-6 min",
    polishPreset: "calm",
    scenes: ["Context", "SOP", "Common Mistakes", "Checklist"],
    requiredInputs: ["target_url", "audience", "role", "task", "mistake"],
  },
  {
    name: "Bug Reproduction Roadmap",
    description: "Environment, minimum repro steps, actual result, expected behavior, and impact.",
    category: "BUG_REPRODUCTION",
    workflowType: "BUG_REPRODUCTION",
    bestFor: "QA, dev handoff",
    durationTarget: "45-120 sec",
    polishPreset: "minimal",
    scenes: ["Environment", "Repro Steps", "Actual Result", "Expected Impact"],
    requiredInputs: ["target_url", "audience", "environment", "actual", "expected", "impact"],
  },
  {
    name: "Documentation Video Roadmap",
    description: "Doc objective, preferred path, expected output, and next step.",
    category: "CLI_TOOL",
    workflowType: "DOCUMENTATION",
    bestFor: "Docs, API, CLI guide",
    durationTarget: "2-5 min",
    polishPreset: "minimal",
    scenes: ["Objective", "Preferred Path", "Expected Output", "Next Step"],
    requiredInputs: ["target_url", "audience", "objective", "output", "next_step"],
  },
] as const;

async function main() {
  console.log("Seeding guided workflow templates...");

  for (const spec of workflowSpecs) {
    const id = `seed-${slugify(spec.name)}`;
    const workflowState = buildWorkflowState(spec.workflowType, spec.scenes);
    await prisma.template.upsert({
      where: { id },
      update: {
        description: spec.description,
        category: spec.category,
        workflowType: spec.workflowType,
        storySource: buildStorySource(spec.name, spec.scenes),
        workflowState,
        bestFor: spec.bestFor,
        durationTarget: spec.durationTarget,
        polishPreset: spec.polishPreset,
        requiredInputs: spec.requiredInputs,
      },
      create: {
        id,
        name: spec.name,
        description: spec.description,
        category: spec.category,
        workflowType: spec.workflowType,
        storySource: buildStorySource(spec.name, spec.scenes),
        workflowState,
        bestFor: spec.bestFor,
        durationTarget: spec.durationTarget,
        polishPreset: spec.polishPreset,
        requiredInputs: spec.requiredInputs,
        workspaceId: null,
        forkCount: 0,
      },
    });
  }

  console.log(`Seeded ${workflowSpecs.length} guided workflow templates.`);
}

function buildStorySource(title: string, scenes: readonly string[]): string {
  const sceneBlocks = scenes
    .map(
      (scene) => `  scene "${scene}" {
    # Replace pause with captured actions for ${scene.toLowerCase()}.
    pause
  }`,
    )
    .join("\n\n");

  return `story "${title}" {
  meta {
    app: "https://example.com"
    viewport: desktop
    theme: dark
    speed: 1.0
  }

${sceneBlocks}
}
`;
}

function buildWorkflowState(workflowType: string, scenes: readonly string[]) {
  const now = Date.now();
  return {
    version: 1,
    type: workflowType.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    steps: scenes.map((scene) => ({
      id: slugify(scene),
      title: scene,
      status: "drafted",
      sceneName: scene,
      requiredInputs: [],
      notes: `Draft the ${scene.toLowerCase()} scene.`,
    })),
  };
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("Seed failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });

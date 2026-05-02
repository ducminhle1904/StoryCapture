CREATE TYPE "WorkflowType" AS ENUM (
  'PRODUCT_DEMO',
  'TUTORIAL',
  'FEATURE_LAUNCH',
  'SALES_MARKETING',
  'SUPPORT',
  'INTERNAL_TRAINING',
  'BUG_REPRODUCTION',
  'DOCUMENTATION',
  'FREESTYLE'
);

ALTER TABLE "Template"
  ADD COLUMN "workflowType" "WorkflowType",
  ADD COLUMN "workflowState" JSONB,
  ADD COLUMN "bestFor" TEXT,
  ADD COLUMN "durationTarget" TEXT,
  ADD COLUMN "polishPreset" TEXT,
  ADD COLUMN "requiredInputs" JSONB;

CREATE INDEX "Template_workflowType_idx" ON "Template"("workflowType");

ALTER TABLE "SyncedProject"
  ADD COLUMN "workflowType" "WorkflowType",
  ADD COLUMN "workflowState" JSONB;

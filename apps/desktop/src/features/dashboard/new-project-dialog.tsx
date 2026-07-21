import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem as AstryxSegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { TextArea as AstryxTextArea } from "@astryxdesign/core/TextArea";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  Bug,
  CheckCircle2,
  ClipboardList,
  FileText,
  FolderOpen,
  GraduationCap,
  HelpCircle,
  Loader2,
  Megaphone,
  MonitorPlay,
  Rocket,
  Sparkles,
  UserRoundCheck,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  buildWorkflowState,
  buildWorkflowStory,
  createWorkflowInputs,
  WORKFLOW_CATALOG,
  type WorkflowCatalogEntry,
  type WorkflowInputs,
} from "@/features/workflows/workflow-catalog";
import { useCreateProject } from "@/ipc/projects";
import { useAppSettingsStore } from "@/state/app-settings";

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}

type CreateMode = "guided" | "freestyle";

const workflowIcons = {
  product_demo: MonitorPlay,
  tutorial: BookOpen,
  feature_launch: Rocket,
  sales_marketing: Megaphone,
  support: Wrench,
  internal_training: GraduationCap,
  bug_reproduction: Bug,
  documentation: FileText,
} as const;

const DEFAULT_WORKFLOW = WORKFLOW_CATALOG[0] as WorkflowCatalogEntry;

export function NewProjectDialog({ open, onOpenChange, onCreated }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [mode, setMode] = useState<CreateMode>("guided");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<WorkflowCatalogEntry["id"]>(
    DEFAULT_WORKFLOW.id,
  );
  const [inputs, setInputs] = useState<WorkflowInputs>(() =>
    createWorkflowInputs(DEFAULT_WORKFLOW),
  );
  const [error, setError] = useState<string | null>(null);
  const create = useCreateProject();
  const settings = useAppSettingsStore((s) => s.settings);

  const selectedWorkflow = useMemo(
    () => WORKFLOW_CATALOG.find((entry) => entry.id === selectedWorkflowId) ?? DEFAULT_WORKFLOW,
    [selectedWorkflowId],
  );

  const filledInputCount = selectedWorkflow.requiredInputs.filter((input) =>
    inputs[input.key]?.trim(),
  ).length;

  useEffect(() => {
    if (!open || parent) return;
    const configured = settings?.general.projects_folder ?? settings?.default_projects_folder;
    if (configured) setParent(configured);
  }, [open, parent, settings]);

  useEffect(() => {
    setInputs((current) => {
      const next = createWorkflowInputs(selectedWorkflow);
      for (const key of Object.keys(next)) {
        next[key] = current[key] ?? "";
      }
      return next;
    });
  }, [selectedWorkflow]);

  const pickParent = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a parent folder for the new project",
      });
      if (typeof picked === "string") setParent(picked);
    } catch (e) {
      setError(String(e));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Project name is required.");
      return;
    }
    if (!parent) {
      setError("Pick a parent folder.");
      return;
    }
    try {
      const guided = mode === "guided";
      const workflowState = guided ? buildWorkflowState(selectedWorkflow) : undefined;
      const project = await create.mutateAsync({
        name: name.trim(),
        parent,
        workflow_type: guided ? selectedWorkflow.id : undefined,
        starter_story_source: guided
          ? buildWorkflowStory(selectedWorkflow, name.trim(), inputs)
          : undefined,
        workflow_state: workflowState,
      });
      setName("");
      setInputs(createWorkflowInputs(DEFAULT_WORKFLOW));
      setSelectedWorkflowId(DEFAULT_WORKFLOW.id);
      setMode("guided");
      onCreated(project.id);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      purpose="form"
      width="min(1120px, calc(100vw - 24px))"
      maxHeight="90dvh"
      padding={0}
      aria-labelledby="new-project-dialog-title"
      aria-describedby="new-project-dialog-description"
    >
      <form onSubmit={submit} className="flex max-h-[90dvh] min-h-0 flex-col">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border-emphasized)] px-5 py-4">
          <div className="min-w-0">
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-background-card)] px-2.5 py-1 font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
              Desktop local first
            </div>
            <h2
              id="new-project-dialog-title"
              className="text-lg font-semibold tracking-tight text-[var(--color-text-primary)]"
            >
              Create Story
            </h2>
            <p
              id="new-project-dialog-description"
              className="mt-1 max-w-[56ch] text-sm leading-5 text-[var(--color-text-secondary)]"
            >
              Choose a focused roadmap, fill only the useful blanks, then open the editor with
              scenes already drafted.
            </p>
          </div>
          <AstryxButton
            label="Close dialog"
            icon={<X size={18} aria-hidden="true" />}
            isIconOnly
            variant="ghost"
            onClick={() => onOpenChange(false)}
          />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid min-h-[560px] lg:grid-cols-[292px_1fr]">
            <ProjectSetupPane
              name={name}
              parent={parent}
              mode={mode}
              guidedStepCount={selectedWorkflow.roadmapSteps.length}
              guidedInputCount={selectedWorkflow.requiredInputs.length}
              filledInputCount={filledInputCount}
              onNameChange={setName}
              onPickParent={pickParent}
              onModeChange={setMode}
            />

            {mode === "guided" ? (
              <GuidedWorkflowSetup
                selectedWorkflow={selectedWorkflow}
                selectedWorkflowId={selectedWorkflowId}
                inputs={inputs}
                onSelectWorkflow={(id) => setSelectedWorkflowId(id)}
                onInputChange={(key, value) =>
                  setInputs((current) => ({ ...current, [key]: value }))
                }
              />
            ) : (
              <FreestylePane />
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--color-border-emphasized)] bg-[var(--story-native-chrome)] px-5 py-4">
          <div
            className="min-w-0 truncate text-sm text-[var(--story-recording)]"
            role={error ? "alert" : undefined}
          >
            {error}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AstryxButton variant="secondary" onClick={() => onOpenChange(false)} label="Cancel">
              Cancel
            </AstryxButton>
            <AstryxButton
              type="submit"
              variant="primary"
              isDisabled={create.isPending}
              icon={
                create.isPending ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={14} aria-hidden="true" />
                )
              }
              label="Create Story"
            >
              Create Story
            </AstryxButton>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}

function ProjectSetupPane({
  name,
  parent,
  mode,
  guidedStepCount,
  guidedInputCount,
  filledInputCount,
  onNameChange,
  onPickParent,
  onModeChange,
}: {
  name: string;
  parent: string;
  mode: CreateMode;
  guidedStepCount: number;
  guidedInputCount: number;
  filledInputCount: number;
  onNameChange: (value: string) => void;
  onPickParent: () => void;
  onModeChange: (mode: CreateMode) => void;
}) {
  return (
    <aside className="border-b border-[var(--color-border-emphasized)] bg-[var(--story-native-chrome)] p-4 lg:border-r lg:border-b-0">
      <div className="grid gap-4">
        <AstryxTextInput
          label="Name"
          isRequired
          value={name}
          onChange={onNameChange}
          placeholder="Customer onboarding demo"
          size="lg"
          width="100%"
        />

        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium text-[var(--color-text-secondary)]">Parent folder</span>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <AstryxTextInput
              label="Parent folder path"
              isLabelHidden
              isDisabled
              disabledMessage="Use Browse to choose the project folder"
              value={parent}
              placeholder="Pick a folder"
              size="lg"
              width="100%"
            />
            <AstryxButton
              variant="secondary"
              size="lg"
              onClick={onPickParent}
              label="Browse for parent folder"
            >
              <FolderOpen size={16} aria-hidden="true" />
              Browse
            </AstryxButton>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-[var(--color-text-secondary)]">Mode</span>
          <AstryxSegmentedControl
            value={mode}
            label="Creation mode"
            onChange={(value) => onModeChange(value as CreateMode)}
          >
            {[
              { value: "guided", label: "Guided" },
              { value: "freestyle", label: "Freestyle" },
            ].map((option) => (
              <AstryxSegmentedControlItem
                key={option.value}
                value={option.value}
                label={typeof option.label === "string" ? option.label : option.value}
                icon={typeof option.label === "string" ? undefined : option.label}
              />
            ))}
          </AstryxSegmentedControl>
        </div>

        <div className="divide-y divide-[var(--color-border)] rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)]">
          <OutputMetric
            icon={mode === "guided" ? Sparkles : HelpCircle}
            label={mode === "guided" ? "Output" : "Starter"}
            value={mode === "guided" ? "Roadmap + scenes" : "Blank story"}
          />
          <OutputMetric
            icon={ClipboardList}
            label={mode === "guided" ? "Roadmap steps" : "Roadmap"}
            value={mode === "guided" ? `${guidedStepCount} phases` : "None"}
          />
          <OutputMetric
            icon={UserRoundCheck}
            label="Inputs"
            value={
              mode === "guided" ? `${filledInputCount}/${guidedInputCount} filled` : "Optional"
            }
          />
        </div>
      </div>
    </aside>
  );
}

function OutputMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Sparkles;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-inner)] bg-[var(--color-background-card)] text-[var(--color-text-secondary)]">
        <Icon size={14} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
          {label}
        </span>
        <span className="block truncate text-xs font-medium text-[var(--color-text-primary)]">
          {value}
        </span>
      </span>
    </div>
  );
}

function GuidedWorkflowSetup({
  selectedWorkflow,
  selectedWorkflowId,
  inputs,
  onSelectWorkflow,
  onInputChange,
}: {
  selectedWorkflow: WorkflowCatalogEntry;
  selectedWorkflowId: WorkflowCatalogEntry["id"];
  inputs: WorkflowInputs;
  onSelectWorkflow: (id: WorkflowCatalogEntry["id"]) => void;
  onInputChange: (key: string, value: string) => void;
}) {
  const SelectedIcon = workflowIcons[selectedWorkflow.id];

  return (
    <section
      className="grid min-w-0 gap-0 xl:grid-cols-[minmax(0,1fr)_340px]"
      aria-label="Guided workflows"
    >
      <div className="min-w-0 border-b border-[var(--color-border-emphasized)] p-4 xl:border-r xl:border-b-0">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
              <SelectedIcon size={16} aria-hidden="true" className="text-[var(--color-accent)]" />
              <span className="truncate">{selectedWorkflow.title}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
              {selectedWorkflow.bestFor}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2.5 py-1 font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
            {selectedWorkflow.durationTarget}
          </span>
        </div>

        <div className="grid gap-2 md:grid-cols-2">
          {WORKFLOW_CATALOG.map((entry) => {
            const Icon = workflowIcons[entry.id];
            const active = entry.id === selectedWorkflowId;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelectWorkflow(entry.id)}
                aria-pressed={active}
                className={[
                  "group min-w-0 rounded-[var(--radius-element)] border p-3 text-left transition duration-200 active:scale-[0.99]",
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    : "border-[var(--color-border)] bg-[var(--color-background-surface)] hover:-translate-y-[1px] hover:border-[var(--color-border-emphasized)] hover:bg-[var(--color-background-card)]",
                ].join(" ")}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={[
                      "grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-inner)] border transition",
                      active
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]"
                        : "border-[var(--color-border)] bg-[var(--color-background-card)] text-[var(--color-text-secondary)] group-hover:text-[var(--color-text-primary)]",
                    ].join(" ")}
                  >
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-[var(--color-text-primary)]">
                      {entry.title}
                    </span>
                    <span className="mt-1 block line-clamp-2 min-h-8 text-xs leading-4 text-[var(--color-text-secondary)]">
                      {entry.bestFor}
                    </span>
                    <span className="mt-2 inline-flex rounded-full border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
                      {entry.durationTarget}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="mt-4 overflow-hidden rounded-[var(--radius-element)] border border-[var(--color-border)]">
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-background-card)] px-3 py-2">
            <ClipboardList size={15} aria-hidden="true" className="text-[var(--color-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {selectedWorkflow.title} roadmap
            </h3>
          </div>
          <ol className="divide-y divide-[var(--color-border)] bg-[var(--color-background-surface)]">
            {selectedWorkflow.roadmapSteps.map((step, index) => (
              <li key={step.id} className="grid grid-cols-[28px_1fr] gap-3 px-3 py-3">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-[var(--color-background-muted)] font-mono text-[10px] text-[var(--color-text-secondary)]">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-[var(--color-text-primary)]">
                    {step.title}
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-secondary)]">
                    {step.notes}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="min-w-0 bg-[var(--story-native-chrome)] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <UserRoundCheck size={15} aria-hidden="true" className="text-[var(--color-accent)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Inputs</h3>
          </div>
          <span className="font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
            Minimum context
          </span>
        </div>
        <div className="space-y-3">
          {selectedWorkflow.requiredInputs.map((input) =>
            input.multiline ? (
              <AstryxTextArea
                key={input.key}
                label={input.label}
                value={inputs[input.key] ?? ""}
                onChange={(value) => onInputChange(input.key, value)}
                placeholder={input.placeholder}
                rows={3}
                width="100%"
              />
            ) : (
              <AstryxTextInput
                key={input.key}
                label={input.label}
                value={inputs[input.key] ?? ""}
                onChange={(value) => onInputChange(input.key, value)}
                placeholder={input.placeholder}
                width="100%"
              />
            ),
          )}
        </div>
      </div>
    </section>
  );
}

function FreestylePane() {
  return (
    <section className="grid min-h-[460px] place-items-center p-6" aria-label="Freestyle">
      <div className="w-full max-w-md overflow-hidden rounded-[var(--radius-container)] border border-dashed border-[var(--color-border-emphasized)] bg-[var(--color-background-surface)]">
        <div className="border-b border-[var(--color-border)] p-5">
          <div className="grid h-10 w-10 place-items-center rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-card)] text-[var(--color-text-secondary)]">
            <HelpCircle size={18} aria-hidden="true" />
          </div>
          <h3 className="mt-4 text-base font-semibold tracking-tight text-[var(--color-text-primary)]">
            Blank story
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--color-text-secondary)]">
            Start with the current pause-only starter and shape the script manually.
          </p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-[var(--color-border)] text-center">
          <div className="p-3">
            <div className="font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
              Scenes
            </div>
            <div className="mt-1 text-sm font-semibold text-[var(--color-text-primary)]">1</div>
          </div>
          <div className="p-3">
            <div className="font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
              Roadmap
            </div>
            <div className="mt-1 text-sm font-semibold text-[var(--color-text-primary)]">Off</div>
          </div>
          <div className="p-3">
            <div className="font-mono text-[10px] uppercase text-[var(--color-text-disabled)]">
              Mode
            </div>
            <div className="mt-1 text-sm font-semibold text-[var(--color-text-primary)]">Open</div>
          </div>
        </div>
      </div>
    </section>
  );
}

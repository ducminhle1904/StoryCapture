"use client";

import {
  ScAccordion,
  ScAccordionContent,
  ScAccordionItem,
  ScAccordionTrigger,
  ScBadge,
  ScButton,
  ScCallout,
  ScCard,
  ScDialog,
  ScDialogClose,
  ScDialogContent,
  ScDialogDescription,
  ScDialogTitle,
  ScDialogTrigger,
  ScEmptyState,
  ScField,
  ScInput,
  ScPopover,
  ScPopoverContent,
  ScPopoverTitle,
  ScPopoverTrigger,
  ScRadioGroup,
  ScRadioGroupItem,
  ScSegmented,
  ScSelect,
  ScSelectContent,
  ScSelectItem,
  ScSelectTrigger,
  ScSelectValue,
  ScSlider,
  ScSwitch,
  ScTabs,
  ScTabsContent,
  ScTabsList,
  ScTabsTrigger,
  ScToggleGroup,
  ScToggleGroupItem,
  ScTooltip,
  ScTooltipContent,
  ScTooltipProvider,
  ScTooltipTrigger,
} from "../index";

export function ComponentCatalog() {
  return (
    <ScTooltipProvider>
      <main className="catalog">
        <div className="catalog-kicker">StoryCapture Design System V2</div>
        <h1>Component catalog</h1>
        <p className="catalog-intro">
          Shared cinematic creator-studio primitives across desktop and web themes, densities, focus
          states, and product workflows.
        </p>

        <div className="catalog-grid">
          <ScCard title="Actions" className="catalog-section">
            <div className="catalog-stack">
              <div className="catalog-row">
                <ScButton variant="primary">Record story</ScButton>
                <ScButton>Preview</ScButton>
                <ScButton variant="ghost">Cancel</ScButton>
                <ScButton variant="danger">Delete</ScButton>
              </div>
              <div className="catalog-row">
                <ScBadge tone="accent">Draft</ScBadge>
                <ScBadge tone="success">Ready</ScBadge>
                <ScBadge tone="warn">Review</ScBadge>
                <ScBadge tone="record">Recording</ScBadge>
              </div>
            </div>
          </ScCard>

          <ScCard title="Fields" className="catalog-section">
            <div className="catalog-stack">
              <ScField
                id="catalog-project-title"
                label="Project title"
                helper="Visible in the shared video page"
              >
                <ScInput className="catalog-field" defaultValue="Payments launch" />
              </ScField>
              <ScSelect defaultValue="1080p">
                <ScSelectTrigger className="catalog-field" aria-label="Resolution">
                  <ScSelectValue />
                </ScSelectTrigger>
                <ScSelectContent>
                  <ScSelectItem value="1080p">1080p</ScSelectItem>
                  <ScSelectItem value="4k">4K</ScSelectItem>
                </ScSelectContent>
              </ScSelect>
              <ScSlider aria-label="Zoom" defaultValue={72} />
            </div>
          </ScCard>

          <ScCard title="Choice controls" className="catalog-section">
            <div className="catalog-stack">
              <ScSegmented
                aria-label="Editor mode"
                value="story"
                options={[
                  { value: "story", label: "Story" },
                  { value: "code", label: "Code" },
                ]}
              />
              <ScToggleGroup aria-label="Canvas fit" defaultValue={["fit"]}>
                <ScToggleGroupItem value="fit">Fit</ScToggleGroupItem>
                <ScToggleGroupItem value="fill">Fill</ScToggleGroupItem>
              </ScToggleGroup>
              <div className="catalog-row">
                <ScRadioGroup aria-label="Theme" defaultValue="dark">
                  <label className="catalog-row">
                    <ScRadioGroupItem value="dark" /> Dark
                  </label>
                  <label className="catalog-row">
                    <ScRadioGroupItem value="light" /> Light
                  </label>
                </ScRadioGroup>
                <ScSwitch aria-label="Enable cursor smoothing" defaultChecked />
                <span className="catalog-note">Cursor smoothing</span>
              </div>
            </div>
          </ScCard>

          <ScCard title="Disclosure" className="catalog-section">
            <ScAccordion defaultValue={["scene-one"]}>
              <ScAccordionItem value="scene-one">
                <ScAccordionTrigger>Scene 1 — Open dashboard</ScAccordionTrigger>
                <ScAccordionContent>
                  Navigate to the workspace and focus the primary call to action.
                </ScAccordionContent>
              </ScAccordionItem>
              <ScAccordionItem value="scene-two">
                <ScAccordionTrigger>Scene 2 — Create project</ScAccordionTrigger>
                <ScAccordionContent>Enter realistic launch details.</ScAccordionContent>
              </ScAccordionItem>
            </ScAccordion>
          </ScCard>

          <ScCard title="Navigation and feedback" className="catalog-section">
            <div className="catalog-stack">
              <ScTabs defaultValue="preview">
                <ScTabsList aria-label="Studio views">
                  <ScTabsTrigger value="preview">Preview</ScTabsTrigger>
                  <ScTabsTrigger value="diagnostics">Diagnostics</ScTabsTrigger>
                </ScTabsList>
                <ScTabsContent value="preview">Live preview connected</ScTabsContent>
                <ScTabsContent value="diagnostics">No blocking diagnostics</ScTabsContent>
              </ScTabs>
              <ScCallout tone="success" title="Ready to record">
                All selectors are valid and the preview is connected.
              </ScCallout>
            </div>
          </ScCard>

          <ScCard title="Overlays and empty states" className="catalog-section">
            <div className="catalog-stack">
              <div className="catalog-row">
                <ScDialog>
                  <ScDialogTrigger
                    render={<ScButton variant="primary">Open export dialog</ScButton>}
                  />
                  <ScDialogContent>
                    <ScDialogTitle>Export video</ScDialogTitle>
                    <ScDialogDescription>
                      Render the current story at 1080p with cursor smoothing.
                    </ScDialogDescription>
                    <div className="catalog-row">
                      <ScDialogClose render={<ScButton>Cancel</ScButton>} />
                      <ScDialogClose render={<ScButton variant="primary">Export</ScButton>} />
                    </div>
                  </ScDialogContent>
                </ScDialog>
                <ScPopover>
                  <ScPopoverTrigger render={<ScButton>Canvas options</ScButton>} />
                  <ScPopoverContent>
                    <ScPopoverTitle>Canvas options</ScPopoverTitle>
                    <p className="catalog-note">Fit, crop, and background controls.</p>
                  </ScPopoverContent>
                </ScPopover>
                <ScTooltip>
                  <ScTooltipTrigger render={<ScButton variant="ghost">Keyboard help</ScButton>} />
                  <ScTooltipContent>Press Command K to open commands.</ScTooltipContent>
                </ScTooltip>
              </div>
              <ScEmptyState
                align="center"
                title="No exports yet"
                body="Finished renders will appear here."
              />
            </div>
          </ScCard>
        </div>
      </main>
    </ScTooltipProvider>
  );
}

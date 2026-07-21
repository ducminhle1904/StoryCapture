"use client";

import type { ReactNode } from "react";
import { ScBadge, ScButton } from "../index";

export type ContractScreenName =
  | "dashboard"
  | "author"
  | "preview"
  | "recorder"
  | "post-production"
  | "export"
  | "settings"
  | "onboarding";

export interface DesktopUxContractProps {
  screen?: ContractScreenName | "gallery";
  state?: string;
}

const STAGES = ["Author", "Preview", "Record", "Edit", "Export"] as const;

const PROJECTS = [
  { name: "Payments launch", workflow: "Feature launch", sessions: 3, age: "12 min ago" },
  { name: "Workspace onboarding", workflow: "Tutorial", sessions: 1, age: "Yesterday" },
  { name: "Invoice approval", workflow: "Product demo", sessions: 0, age: "3 days ago" },
] as const;

function Brand() {
  return (
    <div className="contract-brand">
      <span className="contract-mark">S</span>
      <span>StoryCapture</span>
    </div>
  );
}

function GlobalSidebar({ active = "Projects" }: { active?: "Projects" | "Settings" }) {
  return (
    <aside className="contract-global-sidebar" aria-label="Global navigation">
      <Brand />
      <button className="contract-command" type="button">
        <span>Search and commands</span>
        <kbd>⌘K</kbd>
      </button>
      <nav className="contract-global-nav">
        {(["Projects", "Settings"] as const).map((item) => (
          <button className={active === item ? "active" : ""} type="button" key={item}>
            <span className="contract-nav-glyph" aria-hidden="true" />
            {item}
          </button>
        ))}
      </nav>
      <div className="contract-sidebar-account">
        <span className="contract-avatar">SC</span>
        <span>
          <strong>Local workspace</strong>
          <small>Stored on this Mac</small>
        </span>
      </div>
    </aside>
  );
}

function ProjectStageHeader({
  active,
  primary,
  blocked = [],
}: {
  active: (typeof STAGES)[number];
  primary?: string;
  blocked?: Array<(typeof STAGES)[number]>;
}) {
  return (
    <header className="contract-stage-header">
      <div className="contract-project-identity">
        <button type="button" aria-label="Back to projects">
          ←
        </button>
        <span>
          <strong>Payments launch</strong>
          <small>Feature launch</small>
        </span>
      </div>
      <nav className="contract-stage-rail" aria-label="Project stages">
        {STAGES.map((stage, index) => {
          const isBlocked = blocked.includes(stage);
          const isActive = stage === active;
          const isComplete = STAGES.indexOf(active) > index && !isBlocked;
          return (
            <button
              type="button"
              key={stage}
              className={isActive ? "active" : isComplete ? "complete" : ""}
              disabled={isBlocked}
            >
              <span>{isComplete ? "✓" : index + 1}</span>
              {stage}
            </button>
          );
        })}
      </nav>
      <div className="contract-stage-action">
        {primary ? <ScButton variant="primary">{primary}</ScButton> : null}
      </div>
    </header>
  );
}

function BrowserPreview({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`contract-browser ${compact ? "compact" : ""}`}>
      <div className="contract-browser-bar">
        <span className="contract-browser-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="contract-address">app.atlas.test/billing</span>
        <ScBadge tone="success">Live</ScBadge>
      </div>
      <div className="contract-browser-app">
        <aside>
          <strong>Atlas</strong>
          <span>Overview</span>
          <span className="active">Billing</span>
          <span>Customers</span>
          <span>Settings</span>
        </aside>
        <main>
          <div className="contract-app-heading">
            <span>
              <small>Workspace</small>
              <strong>Billing overview</strong>
            </span>
            <button type="button">Create invoice</button>
          </div>
          <div className="contract-stat-grid">
            <article>
              <small>Monthly volume</small>
              <strong>$48,240</strong>
              <span>+8.4% this month</span>
            </article>
            <article>
              <small>Open invoices</small>
              <strong>18</strong>
              <span>4 need review</span>
            </article>
            <article>
              <small>Payment rate</small>
              <strong>94.7%</strong>
              <span>Last 30 days</span>
            </article>
          </div>
          <div className="contract-chart">
            <span className="contract-chart-copy">
              <small>Revenue</small>
              <strong>Weekly payment volume</strong>
            </span>
            <span className="contract-bars" aria-hidden="true">
              {[42, 58, 47, 74, 63, 82, 92, 76, 96].map((height, index) => (
                <i key={index} style={{ height: `${height}%` }} />
              ))}
            </span>
          </div>
        </main>
      </div>
    </div>
  );
}

function ContractShell({ children, active = "Projects" }: { children: ReactNode; active?: "Projects" | "Settings" }) {
  return (
    <div className="contract-shell">
      <GlobalSidebar active={active} />
      <div className="contract-shell-content">{children}</div>
    </div>
  );
}

function DashboardContract({ state = "populated" }: { state?: string }) {
  const empty = state === "empty";
  const loading = state === "loading";
  const error = state === "error";
  return (
    <ContractShell>
      <header className="contract-toolbar">
        <span>
          <strong>Projects</strong>
          <small>{empty ? "No stories yet" : "3 stories · last opened 12 minutes ago"}</small>
        </span>
        <div className="contract-toolbar-actions">
          <label>
            <span className="sr-only">Search stories</span>
            <input placeholder="Search stories" />
            <kbd>⌘F</kbd>
          </label>
          <ScButton variant="primary">New Story</ScButton>
        </div>
      </header>
      <main className="contract-dashboard">
        {loading ? (
          <div className="contract-project-layout">
            <section className="contract-project-grid">
              {[0, 1, 2, 3, 4, 5].map((item) => (
                <article className="contract-project-card skeleton" key={item} />
              ))}
            </section>
          </div>
        ) : error ? (
          <section className="contract-center-state">
            <ScBadge tone="record">Could not load projects</ScBadge>
            <h1>Your local project index is unavailable</h1>
            <p>Story folders remain on disk. Retry the index before creating another project.</p>
            <ScButton variant="primary">Retry</ScButton>
          </section>
        ) : empty ? (
          <section className="contract-center-state">
            <span className="contract-empty-mark">01</span>
            <h1>Turn one product flow into a polished demo</h1>
            <p>Choose a guided workflow or start with a blank story.</p>
            <ScButton variant="primary">Create your first story</ScButton>
          </section>
        ) : (
          <div className="contract-project-layout">
            <section>
              <div className="contract-section-heading">
                <span>
                  <small>Library</small>
                  <h1>Your stories</h1>
                </span>
                <span>3 projects</span>
              </div>
              <div className="contract-project-grid">
                {PROJECTS.map((project, index) => (
                  <article className="contract-project-card" key={project.name}>
                    <div className={`contract-project-thumb thumb-${index + 1}`}>
                      <span>SC / 0{index + 1}</span>
                      <strong>{project.name}</strong>
                    </div>
                    <div className="contract-project-title">
                      <span>
                        <strong>{project.name}</strong>
                        <small>{project.workflow}</small>
                      </span>
                      <button type="button" aria-label={`More actions for ${project.name}`}>
                        ···
                      </button>
                    </div>
                    <div className="contract-project-meta">
                      <ScBadge tone={project.sessions ? "success" : "accent"}>
                        {project.sessions ? "Recorded" : "Draft"}
                      </ScBadge>
                      <span>{project.sessions} sessions</span>
                      <span>{project.age}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
            <aside className="contract-continue">
              <small>Continue working</small>
              <span className="contract-continue-index">01</span>
              <ScBadge tone="warn">Needs review</ScBadge>
              <h2>Payments launch</h2>
              <p>Your latest recording is ready for a guided review.</p>
              <ol>
                <li className="complete">Author story</li>
                <li className="complete">Record 3 takes</li>
                <li className="active">Review generated polish</li>
              </ol>
              <ScButton variant="primary">Review recording</ScButton>
            </aside>
          </div>
        )}
      </main>
    </ContractShell>
  );
}

function ScenePanel({ invalid = false }: { invalid?: boolean }) {
  return (
    <section className="contract-author-panel">
      <div className="contract-panel-heading">
        <span>
          <small>Scene 01</small>
          <strong>Open billing dashboard</strong>
        </span>
        <ScBadge tone={invalid ? "record" : "success"}>{invalid ? "2 issues" : "Ready"}</ScBadge>
      </div>
      <div className="contract-mode-switch">
        <button type="button" className="active">Story</button>
        <button type="button">Code</button>
      </div>
      <div className="contract-scene-list">
        <article className="active">
          <span>01</span>
          <div><strong>Navigate</strong><small>app.atlas.test/billing</small></div>
        </article>
        <article>
          <span>02</span>
          <div><strong>Click</strong><small>Create invoice</small></div>
        </article>
        <article className={invalid ? "invalid" : ""}>
          <span>03</span>
          <div><strong>Type</strong><small>Customer email</small></div>
        </article>
        <article>
          <span>04</span>
          <div><strong>Assert</strong><small>Invoice created</small></div>
        </article>
      </div>
      <button type="button" className="contract-add-action">+ Add action</button>
      <div className="contract-advanced">
        <button type="button"><span>Advanced</span><small>Motion, cursor, canvas, audio</small><b>⌄</b></button>
      </div>
    </section>
  );
}

function SimulatorStrip({ state = "idle" }: { state?: string }) {
  const current = state === "running" ? 2 : state === "failed" ? 3 : state === "complete" ? 4 : 1;
  return (
    <section className="contract-simulator">
      <header>
        <span><strong>Preview run</strong><small>{state === "idle" ? "Ready · 4 steps" : state === "running" ? "Running step 2 of 4" : state === "failed" ? "Stopped at step 3" : "Passed · 8.4s"}</small></span>
        <ScButton variant={state === "failed" ? "danger" : state === "running" ? "ghost" : "primary"}>
          {state === "failed" ? "Retry failed step" : state === "running" ? "Stop" : state === "complete" ? "Run again" : "Run preview"}
        </ScButton>
      </header>
      <div className="contract-simulator-steps">
        {["Navigate", "Click", "Type", "Assert"].map((step, index) => (
          <article className={index + 1 === current ? state : index + 1 < current ? "complete" : ""} key={step}>
            <span>0{index + 1}</span><strong>{step}</strong><small>{index === 0 ? "1.2s" : index === 1 ? "2.8s" : index === 2 ? "3.1s" : "1.3s"}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function AuthorContract({ state = "valid" }: { state?: string }) {
  const invalid = state === "invalid";
  return (
    <div className="contract-project-screen">
      <ProjectStageHeader active="Author" primary={invalid ? "Fix issues" : "Record"} blocked={invalid ? ["Record", "Edit", "Export"] : ["Edit", "Export"]} />
      <main className="contract-author-workspace">
        <ScenePanel invalid={invalid} />
        <section className="contract-author-preview">
          <header><span><strong>Live preview</strong><small>1280 × 720 · Connected</small></span><button type="button">Focus preview</button></header>
          <div className="contract-preview-pad"><BrowserPreview /></div>
        </section>
      </main>
      <SimulatorStrip state={invalid ? "failed" : "idle"} />
    </div>
  );
}

function PreviewContract({ state = "idle" }: { state?: string }) {
  return (
    <div className="contract-project-screen">
      <ProjectStageHeader active="Preview" primary={state === "complete" ? "Record" : undefined} blocked={["Edit", "Export"]} />
      <main className="contract-preview-workspace">
        <header>
          <span><small>Browser preview</small><strong>Payments launch</strong></span>
          <span className="contract-preview-tools"><button type="button">Fit</button><button type="button">Pick target</button></span>
        </header>
        <div className="contract-preview-main"><BrowserPreview /></div>
      </main>
      <SimulatorStrip state={state} />
    </div>
  );
}

function RecorderContract({ state = "setup" }: { state?: string }) {
  const active = ["recording", "paused", "verifying"].includes(state);
  const completed = state === "completed";
  const failed = state === "failed";
  const primary = completed ? "Review recording" : failed ? "Retry recording" : undefined;
  return (
    <div className="contract-project-screen">
      <ProjectStageHeader active="Record" primary={primary} blocked={active ? ["Author", "Preview", "Edit", "Export"] : ["Edit", "Export"]} />
      <main className="contract-recorder-workspace">
        <section className="contract-recorder-stage">
          <div className={`contract-recording-canvas ${state}`}>
            <BrowserPreview compact />
            <div className="contract-recording-status">
              {state === "setup" && <><ScBadge tone="success">Ready</ScBadge><strong>Browser preview is ready to capture</strong><small>4 steps · 1080p · 60 fps</small></>}
              {state === "recording" && <><ScBadge tone="record">Recording 00:18</ScBadge><strong>Step 2 of 4 · Click Create invoice</strong></>}
              {state === "paused" && <><ScBadge tone="warn">Paused 00:18</ScBadge><strong>Resume when the browser is ready</strong></>}
              {state === "verifying" && <><ScBadge tone="accent">Verifying 72%</ScBadge><strong>Checking cadence and master hashes</strong></>}
              {completed && <><ScBadge tone="success">Verified</ScBadge><strong>Recording complete</strong><small>00:42 · Exact 1080p60 · 3.8 GB</small></>}
              {failed && <><ScBadge tone="record">Verification failed</ScBadge><strong>Cadence drift exceeded strict policy</strong><small>The previous valid take remains available.</small></>}
            </div>
          </div>
          <footer className="contract-recorder-controls">
            <span>{state === "setup" ? "Ready · 4 steps" : completed ? "Saved to Payments launch" : failed ? "Review diagnostics before retrying" : "Recording controls are locked"}</span>
            <div>
              {state === "setup" && <ScButton variant="danger">Start recording</ScButton>}
              {state === "recording" && <><ScButton>Pause</ScButton><ScButton variant="danger">Stop</ScButton></>}
              {state === "paused" && <><ScButton variant="primary">Resume</ScButton><ScButton variant="danger">Stop</ScButton></>}
              {state === "verifying" && <ScButton disabled>Verifying</ScButton>}
              {completed && <><ScButton>Record another take</ScButton><ScButton variant="primary">Review recording</ScButton></>}
              {failed && <ScButton variant="danger">Retry recording</ScButton>}
            </div>
          </footer>
        </section>
        <aside className="contract-readiness">
          <header><small>Capture setup</small><strong>Readiness</strong></header>
          {["Screen recording", "Browser target", "Microphone", "Output quality"].map((item, index) => (
            <article key={item}><span className={index === 2 ? "warn" : "ok"}>{index === 2 ? "!" : "✓"}</span><div><strong>{item}</strong><small>{index === 2 ? "System audio only" : index === 3 ? "Strict · 1080p60" : "Ready"}</small></div></article>
          ))}
          <button type="button" className="contract-disclosure"><span>Advanced settings</span><b>⌄</b></button>
        </aside>
      </main>
    </div>
  );
}

function ReviewPanel({ blocked = false }: { blocked?: boolean }) {
  return (
    <aside className="contract-review-panel">
      <header><span><small>Guided review</small><strong>{blocked ? "Review needed before export" : "Ready for a final pass"}</strong></span><ScBadge tone={blocked ? "warn" : "success"}>{blocked ? "2 issues" : "Exportable"}</ScBadge></header>
      <div className="contract-review-stats"><span><strong>3</strong><small>Zooms</small></span><span><strong>1</strong><small>Callout</small></span><span><strong>42s</strong><small>Duration</small></span></div>
      <section><small>Recommended fixes</small>
        <button type="button" className={blocked ? "critical" : ""}><span>01</span><div><strong>{blocked ? "Missing target geometry" : "Review first zoom"}</strong><small>{blocked ? "Step 3 needs a confirmed target" : "Generated at 00:08"}</small></div><b>→</b></button>
        <button type="button"><span>02</span><div><strong>Check cursor emphasis</strong><small>Generated at 00:21</small></div><b>→</b></button>
      </section>
      <ScButton>Fine Tune</ScButton>
    </aside>
  );
}

function Timeline() {
  return (
    <section className="contract-timeline">
      <header><strong>Timeline</strong><span>1V · 3Z · 1T</span><button type="button">Fit</button></header>
      <div className="contract-timeline-grid">
        <span className="contract-track-labels"><b>Video</b><b>Zoom</b><b>Text</b><b>Audio</b></span>
        <div className="contract-tracks">
          <i className="playhead" />
          <span className="clip video">Payments launch · 00:42</span>
          <span className="clip zoom z1">Zoom</span><span className="clip zoom z2">Zoom</span><span className="clip zoom z3">Zoom</span>
          <span className="clip text">Create your first invoice</span>
          <span className="clip audio">System audio</span>
        </div>
      </div>
    </section>
  );
}

function PostProductionContract({ state = "review" }: { state?: string }) {
  const fineTune = state === "fine-tune";
  const blocked = state === "export-blocked";
  return (
    <div className="contract-project-screen">
      <ProjectStageHeader active={blocked || state === "export-ready" ? "Export" : "Edit"} primary={blocked ? "Fix 2 issues" : "Export"} blocked={blocked ? ["Export"] : []} />
      <main className={`contract-post-workspace ${fineTune ? "fine-tune" : ""}`}>
        <section className="contract-post-preview"><header><span><small>Preview</small><strong>Latest verified take</strong></span><button type="button">Focus preview</button></header><div><BrowserPreview /></div></section>
        {fineTune ? <aside className="contract-inspector"><header><small>Inspector</small><strong>Zoom clip</strong></header><label>Scale<input type="range" defaultValue="72" /></label><label>Position<div className="contract-position-grid"><i /><i /><i /><i className="active" /><i /><i /><i /><i /><i /></div></label><label>Motion<select defaultValue="smooth"><option value="smooth">Smooth focus</option></select></label></aside> : <ReviewPanel blocked={blocked} />}
      </main>
      {fineTune ? <Timeline /> : null}
    </div>
  );
}

function ExportContract({ state = "ready" }: { state?: string }) {
  const blocked = state === "blocked";
  return (
    <div className="contract-export-screen">
      <PostProductionContract state={blocked ? "export-blocked" : "export-ready"} />
      <div className="contract-modal-backdrop" />
      <section className="contract-export-modal" role="dialog" aria-label="Export video">
        <header><span><small>Final output</small><strong>Export video</strong></span><button type="button">×</button></header>
        <div className="contract-export-summary"><span className="contract-output-poster">SC / 01</span><div><strong>Payments launch</strong><small>00:42 · 1920 × 1080 · 60 fps</small></div></div>
        <div className="contract-export-options"><label>Preset<select defaultValue="standard"><option value="standard">Standard · H.264</option></select></label><label>File name<input defaultValue="payments-launch.mp4" /></label></div>
        <div className={`contract-preflight ${blocked ? "blocked" : "ready"}`}><span>{blocked ? "!" : "✓"}</span><div><strong>{blocked ? "2 issues block export" : "Ready to export"}</strong><small>{blocked ? "Confirm target geometry and restore the video track." : "Timeline, audio and output settings passed preflight."}</small></div></div>
        <footer><span>Estimated size 34 MB</span><div><ScButton>Cancel</ScButton><ScButton variant="success" disabled={blocked}>{blocked ? "Export blocked" : "Export MP4"}</ScButton></div></footer>
      </section>
    </div>
  );
}

const SETTINGS_GROUPS = [
  ["Workspace", "General", "Web account", "Keyboard"],
  ["Capture", "Capture defaults"],
  ["Output", "Render defaults"],
  ["Connections", "API keys"],
  ["System", "Privacy", "Logs", "About"],
] as const;

function SettingsContract() {
  return (
    <ContractShell active="Settings">
      <header className="contract-toolbar"><span><strong>Settings</strong><small>Workspace · Local</small></span><ScButton variant="ghost">Reset General</ScButton></header>
      <main className="contract-settings">
        <nav aria-label="Settings sections">
          {SETTINGS_GROUPS.map(([group, ...items]) => <section key={group}><small>{group}</small>{items.map((item) => <button type="button" className={item === "General" ? "active" : ""} key={item}>{item}</button>)}</section>)}
        </nav>
        <section className="contract-settings-panel">
          <header><span><small>Workspace</small><h1>General</h1><p>Control startup behavior, appearance and local project storage.</p></span><ScBadge tone="success">Saved</ScBadge></header>
          <div className="contract-setting-group"><div><strong>Appearance</strong><small>Use your system theme or choose a fixed appearance.</small></div><select defaultValue="system"><option value="system">System</option></select></div>
          <div className="contract-setting-group"><div><strong>Projects folder</strong><small>New stories are created inside this folder.</small></div><button type="button">~/Movies/StoryCapture</button></div>
          <div className="contract-setting-group"><div><strong>Open at launch</strong><small>Choose the first screen shown when StoryCapture starts.</small></div><select defaultValue="projects"><option value="projects">Projects</option></select></div>
          <div className="contract-setting-group"><div><strong>Reduce motion</strong><small>Minimize panel movement and recording pulses.</small></div><button type="button" className="contract-switch"><i /></button></div>
        </section>
      </main>
    </ContractShell>
  );
}

function OnboardingContract({ state = "goal" }: { state?: string }) {
  const steps = ["Goal", "Target", "Permissions", "Project setup"];
  const activeIndex = Math.max(0, steps.findIndex((item) => item.toLowerCase().replace(" ", "-") === state));
  return (
    <main className="contract-onboarding">
      <header><Brand /><nav>{steps.map((step, index) => <span className={index === activeIndex ? "active" : index < activeIndex ? "complete" : ""} key={step}><i>{index < activeIndex ? "✓" : index + 1}</i>{step}</span>)}</nav><button type="button">Skip setup</button></header>
      <section>
        <div className="contract-onboarding-copy"><small>Step {activeIndex + 1} of 4</small><h1>{state === "goal" ? "What are you creating?" : state === "target" ? "Choose the product flow" : state === "permissions" ? "Prepare recording access" : "Create the local project"}</h1><p>{state === "goal" ? "Pick a workflow so the starter story matches the demo you need." : state === "target" ? "StoryCapture will use this URL in the generated story." : state === "permissions" ? "Check access now so the first recording starts without surprise prompts." : "Review the workflow and choose where the project should live."}</p></div>
        <div className="contract-onboarding-card">
          {state === "goal" && <div className="contract-goal-grid">{["Product Demo", "Tutorial", "Feature Launch", "Support"].map((goal, index) => <button type="button" className={index === 2 ? "active" : ""} key={goal}><span>0{index + 1}</span><strong>{goal}</strong><small>{index === 2 ? "Present a release through a focused product path." : "Start with a structured story workflow."}</small></button>)}</div>}
          {state === "target" && <div className="contract-target-form"><label>Product URL<input defaultValue="https://app.atlas.test/billing" /></label><span>Feature Launch will use this target in the starter story.</span><BrowserPreview compact /></div>}
          {state === "permissions" && <div className="contract-permission-list">{[["Screen recording", "Granted", "success"], ["Accessibility", "Granted", "success"], ["Browser sidecar", "Connected", "success"], ["Microphone", "Not configured", "warn"]].map(([name, status, tone]) => <article key={name}><span className={tone}>{tone === "success" ? "✓" : "!"}</span><div><strong>{name}</strong><small>{status}</small></div><button type="button">Check</button></article>)}</div>}
          {state === "project-setup" && <div className="contract-project-setup"><label>Project name<input defaultValue="Payments launch" /></label><label>Parent folder<button type="button">~/Movies/StoryCapture</button></label><div><small>Starter workflow</small><strong>Feature Launch</strong><span>4 scenes · target URL configured</span></div></div>}
        </div>
      </section>
      <footer><ScButton disabled={activeIndex === 0}>Back</ScButton><span><small>{Math.round(((activeIndex + 1) / 4) * 100)}% complete</small><i><b style={{ width: `${((activeIndex + 1) / 4) * 100}%` }} /></i></span><ScButton variant="primary">{activeIndex === 3 ? "Create project" : "Continue"}</ScButton></footer>
    </main>
  );
}

function ContractScreen({ screen, state }: { screen: ContractScreenName; state?: string }) {
  if (screen === "dashboard") return <DashboardContract state={state} />;
  if (screen === "author") return <AuthorContract state={state} />;
  if (screen === "preview") return <PreviewContract state={state} />;
  if (screen === "recorder") return <RecorderContract state={state} />;
  if (screen === "post-production") return <PostProductionContract state={state} />;
  if (screen === "export") return <ExportContract state={state} />;
  if (screen === "settings") return <SettingsContract />;
  return <OnboardingContract state={state} />;
}

const GALLERY: Array<{ screen: ContractScreenName; state: string; label: string }> = [
  { screen: "dashboard", state: "populated", label: "Dashboard" },
  { screen: "author", state: "valid", label: "Author" },
  { screen: "preview", state: "running", label: "Preview" },
  { screen: "recorder", state: "completed", label: "Recorder" },
  { screen: "post-production", state: "review", label: "Guided review" },
  { screen: "export", state: "ready", label: "Export" },
  { screen: "settings", state: "general", label: "Settings" },
  { screen: "onboarding", state: "goal", label: "Onboarding" },
];

function ContractGallery() {
  return (
    <main className="contract-gallery">
      <header><small>StoryCapture Desktop UX V2.1</small><h1>Project pipeline visual contract</h1><p>Author → Preview → Record → Edit → Export</p></header>
      <div className="contract-gallery-grid">
        {GALLERY.map((item) => <article key={item.screen}><div className="contract-gallery-frame"><div className="contract-gallery-scale"><ContractScreen screen={item.screen} state={item.state} /></div></div><span><strong>{item.label}</strong><small>{item.state}</small></span></article>)}
      </div>
    </main>
  );
}

export function DesktopUxContract({ screen = "gallery", state }: DesktopUxContractProps) {
  return screen === "gallery" ? <ContractGallery /> : <ContractScreen screen={screen} state={state} />;
}

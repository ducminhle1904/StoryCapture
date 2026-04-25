import { ScBadge, ScButton } from "@storycapture/ui";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowRight,
  Check,
  Circle,
  Clock,
  Film,
  Gauge,
  MousePointer2,
  Play,
  ShieldCheck,
  Sparkles,
  Target,
  Timer,
  Video,
} from "lucide-react";

const flowSteps = [
  {
    id: "welcome",
    label: "Outcome pitch",
    title: "Create a product demo video from a script",
    body: "Set the expectation around the finished asset, not the list of editor features.",
    state: "done",
  },
  {
    id: "goal",
    label: "Personalize",
    title: "Choose the job",
    body: "Launch demo, onboarding video, support walkthrough, release note, or bug repro.",
    state: "done",
  },
  {
    id: "target",
    label: "Target",
    title: "Enter product URL or use sample",
    body: "Let first-time users reach value without a real project or account setup.",
    state: "active",
  },
  {
    id: "permissions",
    label: "Readiness",
    title: "Explain capture permissions before OS prompts",
    body: "Screen recording and accessibility prompts need context before the native dialog.",
    state: "next",
  },
  {
    id: "preview",
    label: "Aha",
    title: "Run preview and see the browser move",
    body: "The first trust moment is watching a scripted browser flow work.",
    state: "next",
  },
  {
    id: "record",
    label: "Clip",
    title: "Record a 10-second sample",
    body: "Keep scope small but real: native pixels, cursor, and a visible timeline.",
    state: "next",
  },
  {
    id: "export",
    label: "Finish",
    title: "Show polished timeline and export",
    body: "End with the user holding a finished local video; sign-in only gates sharing.",
    state: "next",
  },
];

const jobs = ["Launch demo", "Onboarding video", "Support walkthrough", "Release note"];

const checklistItems = [
  ["Add target URL", "done"],
  ["Generate starter .story", "done"],
  ["Run preview", "active"],
  ["Pick or repair one selector", "next"],
  ["Record first clip", "next"],
  ["Open post-production", "next"],
  ["Export local video", "next"],
  ["Share to web", "optional"],
];

const permissionItems = [
  ["Screen Recording", "Required for crisp native capture"],
  ["Accessibility", "Required for guided browser control"],
  ["Browser sidecar", "Used for preview and element picking"],
];

const metricRows = [
  {
    event: "onboarding_started",
    question: "How many new users enter the flow?",
    properties: "source, version, has_projects",
  },
  {
    event: "goal_selected",
    question: "Which jobs should templates and presets optimize for?",
    properties: "goal, skipped, elapsed_ms",
  },
  {
    event: "time_to_first_preview",
    question: "How fast do users reach the first browser automation aha moment?",
    properties: "project_type, sample_used, duration_ms",
  },
  {
    event: "permission_prompt_result",
    question: "Which native permissions block activation?",
    properties: "permission, accepted, retries, platform",
  },
  {
    event: "first_recording_completed",
    question: "Can users produce a real clip during onboarding?",
    properties: "duration_sec, failed_steps, browser_target",
  },
  {
    event: "first_export_completed",
    question: "Does onboarding produce a finished local video?",
    properties: "resolution, format, elapsed_ms",
  },
  {
    event: "share_prompt_result",
    question: "When does web sign-in feel worth it?",
    properties: "signed_in, uploaded, workspace_id",
  },
];

const stateRows = [
  ["Loading", "Skeleton project shell while permissions and sample assets initialize."],
  [
    "Empty",
    "Use sample project, import .story, or paste a product URL. Never show a blank dashboard.",
  ],
  ["Error", "Inline recovery for denied permissions, unreachable URLs, and selector failures."],
];

const qualityThresholds: Array<{ label: string; value: string; icon: LucideIcon }> = [
  { label: "Time to preview", value: "< 90s", icon: Timer },
  { label: "Permission retry", value: "< 1.4x", icon: ShieldCheck },
  { label: "First recording", value: "> 47.2%", icon: Video },
  { label: "Export completion", value: "> 31.6%", icon: Clock },
];

function StatusDot({ state }: { state: string }) {
  const tone =
    state === "done"
      ? "bg-[var(--sc-success)]"
      : state === "active"
        ? "bg-[var(--sc-accent-400)]"
        : state === "optional"
          ? "bg-[var(--sc-text-4)]"
          : "bg-[var(--sc-surface-4)]";

  return (
    <span
      className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full ${tone} text-[10px] text-[var(--sc-text-inverse)]`}
    >
      {state === "done" ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Circle size={6} aria-hidden="true" />
      )}
    </span>
  );
}

export default function OnboardingRoute() {
  return (
    <main id="main-content" className="sc-scroll h-full overflow-auto bg-[var(--sc-bg)]">
      <div className="mx-auto max-w-[1400px] px-5 py-5 lg:px-7 lg:py-7">
        <header className="mb-5 flex flex-col gap-4 border-b border-[var(--sc-border)] pb-5 lg:flex-row lg:items-end">
          <div className="max-w-[760px]">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <ScBadge tone="accent">Onboarding design</ScBadge>
              <ScBadge tone="muted">Desktop activation</ScBadge>
              <ScBadge tone="info">Metrics plan</ScBadge>
            </div>
            <h1 className="text-[clamp(34px,4.8vw,62px)] font-semibold leading-none text-[var(--sc-text)]">
              Bring users to their first demo, not their first tooltip.
            </h1>
            <p className="mt-4 max-w-[720px] text-[14px] leading-7 text-[var(--sc-text-3)]">
              StoryCapture onboarding should behave like a miniature production run: choose a job,
              create a tiny script, watch the browser move, record a short clip, then see the
              polished timeline. Account sign-in waits until sharing creates value.
            </p>
          </div>
          <div className="flex gap-2 lg:ml-auto">
            <ScButton icon={<Play size={13} aria-hidden="true" />}>Preview flow</ScButton>
            <ScButton variant="primary" icon={<ArrowRight size={13} aria-hidden="true" />}>
              Ship as first-run
            </ScButton>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(520px,1.28fr)]">
          <div className="space-y-4">
            <div className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-5 shadow-[var(--sc-sh-1)]">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-[11px] uppercase text-[var(--sc-accent-300)]">
                    Activation path
                  </p>
                  <h2 className="mt-1 text-[20px] font-semibold">
                    A seven-step flow with one aha moment
                  </h2>
                </div>
                <div className="rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--sc-text-3)]">
                  03 / 07
                </div>
              </div>

              <div className="space-y-3">
                {flowSteps.map((step) => (
                  <article
                    key={step.id}
                    className={`grid grid-cols-[20px_1fr] gap-3 rounded-[var(--sc-r-lg)] border p-3 transition ${
                      step.state === "active"
                        ? "border-[oklch(0.78_0.14_var(--sc-accent-h)/0.45)] bg-[oklch(0.78_0.14_var(--sc-accent-h)/0.10)]"
                        : "border-[var(--sc-border)] bg-[var(--sc-surface-2)]"
                    }`}
                  >
                    <StatusDot state={step.state} />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[10.5px] uppercase text-[var(--sc-text-4)]">
                          {step.label}
                        </span>
                        {step.state === "active" && <ScBadge tone="accent">Current screen</ScBadge>}
                      </div>
                      <h3 className="mt-1 text-[13px] font-semibold">{step.title}</h3>
                      <p className="mt-1 text-[12px] leading-5 text-[var(--sc-text-3)]">
                        {step.body}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <div className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-5 shadow-[var(--sc-sh-1)]">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] text-[var(--sc-accent-300)]">
                  <ShieldCheck size={17} aria-hidden="true" />
                </div>
                <div>
                  <h2 className="text-[16px] font-semibold">Permission readiness</h2>
                  <p className="mt-1 text-[12px] leading-5 text-[var(--sc-text-3)]">
                    Native prompts should never appear cold. Explain the job, show what still works
                    if denied, then open the OS dialog.
                  </p>
                </div>
              </div>
              <div className="mt-4 divide-y divide-[var(--sc-border)] rounded-[var(--sc-r-lg)] border border-[var(--sc-border)]">
                {permissionItems.map(([title, body]) => (
                  <div key={title} className="grid gap-1 px-3 py-3 sm:grid-cols-[150px_1fr]">
                    <div className="text-[12px] font-semibold">{title}</div>
                    <div className="text-[12px] leading-5 text-[var(--sc-text-3)]">{body}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="overflow-hidden rounded-[18px] border border-[var(--sc-border-2)] bg-[var(--sc-bg)] shadow-[0_30px_90px_rgba(0,0,0,0.44)]">
              <div className="grid h-11 grid-cols-[90px_1fr_120px] items-center border-b border-[var(--sc-border)] bg-[var(--sc-chrome)] px-4">
                <div className="flex gap-2">
                  <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                  <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
                  <span className="h-3 w-3 rounded-full bg-[#28c840]" />
                </div>
                <div className="text-center text-[12px] font-semibold text-[var(--sc-text-3)]">
                  First-run setup
                </div>
                <div className="text-right font-mono text-[10.5px] text-[var(--sc-text-4)]">
                  sample.story
                </div>
              </div>

              <div className="grid min-h-[560px] gap-0 lg:grid-cols-[1fr_290px]">
                <div className="p-5 sm:p-7">
                  <div className="mb-6 max-w-[560px]">
                    <p className="font-mono text-[11px] uppercase text-[var(--sc-accent-300)]">
                      Step 3
                    </p>
                    <h2 className="mt-2 text-[30px] font-semibold leading-[1.02]">
                      What product flow should we turn into a demo video?
                    </h2>
                    <p className="mt-3 text-[13px] leading-6 text-[var(--sc-text-3)]">
                      Use a sample project now, or paste a URL. The next screen generates a starter
                      script and runs preview before asking for recording permissions.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {jobs.map((job, index) => (
                      <button
                        key={job}
                        type="button"
                        className={`group rounded-[var(--sc-r-lg)] border p-4 text-left transition active:translate-y-px ${
                          index === 0
                            ? "border-[oklch(0.78_0.14_var(--sc-accent-h)/0.5)] bg-[oklch(0.78_0.14_var(--sc-accent-h)/0.10)]"
                            : "border-[var(--sc-border)] bg-[var(--sc-surface)] hover:bg-[var(--sc-hover)]"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Target
                            size={14}
                            className="text-[var(--sc-accent-300)]"
                            aria-hidden="true"
                          />
                          <span className="text-[13px] font-semibold">{job}</span>
                        </div>
                        <p className="mt-2 text-[12px] leading-5 text-[var(--sc-text-3)]">
                          {index === 0
                            ? "Launch-ready script, capture, edit, and export defaults."
                            : "A focused starter flow with matching copy and output presets."}
                        </p>
                      </button>
                    ))}
                  </div>

                  <div className="mt-5 rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                    <label className="text-[12px] font-semibold" htmlFor="demo-target">
                      Product URL
                    </label>
                    <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                      <input
                        id="demo-target"
                        className="h-9 rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-3 text-[13px] text-[var(--sc-text)] outline-none placeholder:text-[var(--sc-text-4)] focus:border-[var(--sc-focus)]"
                        placeholder="https://app.yourproduct.com/signup"
                      />
                      <ScButton variant="primary" icon={<Sparkles size={13} aria-hidden="true" />}>
                        Generate starter story
                      </ScButton>
                    </div>
                    <p className="mt-2 text-[11.5px] leading-5 text-[var(--sc-text-4)]">
                      No URL yet? Continue with the built-in onboarding sample and replace it later.
                    </p>
                  </div>

                  <div className="mt-5 grid gap-3 md:grid-cols-[1.15fr_0.85fr]">
                    <div className="rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[13px] font-semibold">Aha moment preview</div>
                          <div className="mt-1 text-[11.5px] text-[var(--sc-text-4)]">
                            Browser movement before education
                          </div>
                        </div>
                        <ScBadge tone="success">Ready</ScBadge>
                      </div>
                      <div className="mt-4 overflow-hidden rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-text)] p-3 text-[var(--sc-text-inverse)]">
                        <div className="mb-3 flex h-6 items-center gap-1.5 rounded bg-[var(--sc-n-100)] px-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--sc-record)]" />
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--sc-warn)]" />
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--sc-success)]" />
                        </div>
                        <div className="space-y-2">
                          <div className="h-3 w-3/5 rounded bg-[var(--sc-n-200)]" />
                          <div className="h-20 rounded bg-[var(--sc-n-100)]" />
                          <div className="grid grid-cols-3 gap-2">
                            <div className="h-8 rounded bg-[var(--sc-n-200)]" />
                            <div className="h-8 rounded bg-[var(--sc-accent-300)]" />
                            <div className="h-8 rounded bg-[var(--sc-n-200)]" />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-4">
                      <div className="flex items-center gap-2">
                        <MousePointer2
                          size={14}
                          className="text-[var(--sc-accent-300)]"
                          aria-hidden="true"
                        />
                        <h3 className="text-[13px] font-semibold">What answers unlock</h3>
                      </div>
                      <div className="mt-4 space-y-3">
                        {[
                          "Starter .story",
                          "Launch demo preset",
                          "Export target: landing page",
                        ].map((item) => (
                          <div
                            key={item}
                            className="flex items-center gap-2 text-[12px] text-[var(--sc-text-3)]"
                          >
                            <Check
                              size={13}
                              className="text-[var(--sc-success)]"
                              aria-hidden="true"
                            />
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <aside className="border-t border-[var(--sc-border)] bg-[var(--sc-chrome)] p-4 lg:border-l lg:border-t-0">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[13px] font-semibold">Activation checklist</h3>
                    <span className="font-mono text-[11px] text-[var(--sc-text-4)]">2 / 8</span>
                  </div>
                  <div className="mt-4 space-y-2">
                    {checklistItems.map(([item, state]) => (
                      <div
                        key={item}
                        className={`flex items-start gap-2 rounded-[var(--sc-r-md)] border px-3 py-2 ${
                          state === "active"
                            ? "border-[oklch(0.78_0.14_var(--sc-accent-h)/0.45)] bg-[oklch(0.78_0.14_var(--sc-accent-h)/0.10)]"
                            : "border-[var(--sc-border)] bg-[var(--sc-surface)]"
                        }`}
                      >
                        <StatusDot state={state} />
                        <span className="text-[12px] leading-5 text-[var(--sc-text-2)]">
                          {item}
                        </span>
                      </div>
                    ))}
                  </div>
                </aside>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,0.88fr)_minmax(560px,1.12fr)]">
          <div className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-5 shadow-[var(--sc-sh-1)]">
            <div className="flex items-start gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] text-[var(--sc-accent-300)]">
                <Film size={17} aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-[16px] font-semibold">Post-aha handoff</h2>
                <p className="mt-1 text-[12px] leading-5 text-[var(--sc-text-3)]">
                  Once the user sees the browser move, keep momentum with a short recording and a
                  visible timeline. This is where onboarding should stop explaining and start
                  producing.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {["Preview passed", "10-second clip recorded", "Post-production timeline opened"].map(
                (item, index) => (
                  <div key={item} className="grid grid-cols-[90px_1fr] items-center gap-3">
                    <span className="font-mono text-[11px] text-[var(--sc-text-4)]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="h-8 rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] p-1">
                      <div
                        className="h-full rounded-[var(--sc-r-sm)] bg-[var(--sc-accent-500)]/60"
                        style={{ width: `${82 - index * 16}%` }}
                      />
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>

          <div className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] shadow-[var(--sc-sh-1)]">
            <div className="grid gap-2 border-b border-[var(--sc-border)] px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <p className="font-mono text-[11px] uppercase text-[var(--sc-accent-300)]">
                  Metrics to track
                </p>
                <h2 className="mt-1 text-[18px] font-semibold">
                  Measure activation, not screen completion
                </h2>
              </div>
              <ScBadge tone="info">7 core events</ScBadge>
            </div>
            <div className="divide-y divide-[var(--sc-border)]">
              {metricRows.map((row) => (
                <div
                  key={row.event}
                  className="grid gap-3 px-5 py-4 lg:grid-cols-[210px_1fr_220px]"
                >
                  <div className="flex items-center gap-2 font-mono text-[11.5px] text-[var(--sc-accent-300)]">
                    <Activity size={13} aria-hidden="true" />
                    {row.event}
                  </div>
                  <div className="text-[12px] leading-5 text-[var(--sc-text-2)]">
                    {row.question}
                  </div>
                  <div className="font-mono text-[11px] leading-5 text-[var(--sc-text-4)]">
                    {row.properties}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.35fr]">
          <div className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-5 shadow-[var(--sc-sh-1)]">
            <div className="flex items-center gap-2">
              <Gauge size={16} className="text-[var(--sc-accent-300)]" aria-hidden="true" />
              <h2 className="text-[16px] font-semibold">Quality thresholds</h2>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {qualityThresholds.map(({ label, value, icon: Icon }) => (
                <div
                  key={label}
                  className="rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] p-4"
                >
                  <div className="flex items-center gap-2 text-[var(--sc-text-3)]">
                    <Icon size={14} aria-hidden="true" />
                    <span className="text-[12px]">{label}</span>
                  </div>
                  <div className="mt-3 font-mono text-[24px] font-semibold text-[var(--sc-text)]">
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] shadow-[var(--sc-sh-1)]">
            <div className="border-b border-[var(--sc-border)] px-5 py-4">
              <h2 className="text-[16px] font-semibold">Required UI states before shipping</h2>
              <p className="mt-1 text-[12px] leading-5 text-[var(--sc-text-3)]">
                The flow must handle waiting, no project context, and permission or preview failure
                without breaking the user's sense of progress.
              </p>
            </div>
            <div className="divide-y divide-[var(--sc-border)]">
              {stateRows.map(([state, body]) => (
                <div key={state} className="grid gap-2 px-5 py-4 sm:grid-cols-[130px_1fr]">
                  <div className="text-[13px] font-semibold">{state}</div>
                  <div className="text-[12px] leading-5 text-[var(--sc-text-3)]">{body}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

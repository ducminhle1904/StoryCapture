import { ScBadge, ScButton } from "@storycapture/ui";
import {
  ArrowRight,
  ChevronLeft,
  Film,
  FolderPlus,
  Play,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import goalLaunchArtwork from "@/assets/onboarding/goal-launch.jpg";
import goalOnboardingArtwork from "@/assets/onboarding/goal-onboarding.jpg";
import goalReleaseArtwork from "@/assets/onboarding/goal-release.jpg";
import goalSupportArtwork from "@/assets/onboarding/goal-support.jpg";
import outcomeArtwork from "@/assets/onboarding/outcome-demo.jpg";
import permissionsArtwork from "@/assets/onboarding/permissions.jpg";
import previewArtwork from "@/assets/onboarding/preview-run.jpg";
import targetSampleArtwork from "@/assets/onboarding/target-sample.jpg";
import targetUrlArtwork from "@/assets/onboarding/target-url.jpg";
import { markOnboardingComplete } from "@/lib/onboarding";
import { useDashboardStore } from "@/state/projects";

type StepId = "outcome" | "goal" | "target" | "permissions" | "preview";

interface Step {
  id: StepId;
  label: string;
  title: string;
  eyebrow: string;
}

const steps: Step[] = [
  {
    id: "outcome",
    label: "Outcome",
    title: "Create your first product demo",
    eyebrow: "Start with the finished result",
  },
  {
    id: "goal",
    label: "Goal",
    title: "What are you making?",
    eyebrow: "We will tailor the starter story",
  },
  {
    id: "target",
    label: "Target",
    title: "Pick the product flow",
    eyebrow: "Use a URL or the built-in sample",
  },
  {
    id: "permissions",
    label: "Ready",
    title: "Prepare recording access",
    eyebrow: "No surprise system prompts",
  },
  {
    id: "preview",
    label: "Preview",
    title: "Watch the browser move",
    eyebrow: "The first aha moment",
  },
];

const goals = [
  {
    id: "launch",
    title: "Launch demo",
    body: "Show the product path that sells a release.",
    artwork: goalLaunchArtwork,
  },
  {
    id: "onboarding",
    title: "Customer onboarding",
    body: "Teach a new user the first useful action.",
    artwork: goalOnboardingArtwork,
  },
  {
    id: "support",
    title: "Support walkthrough",
    body: "Record the steps that solve a support ticket.",
    artwork: goalSupportArtwork,
  },
  {
    id: "release",
    title: "Release note",
    body: "Turn a feature change into a short clip.",
    artwork: goalReleaseArtwork,
  },
];

const permissionRows = [
  ["Screen Recording", "Captures crisp native pixels for the final video."],
  ["Accessibility", "Lets StoryCapture guide browser clicks and inputs."],
  ["Browser sidecar", "Runs preview in a controlled browser first."],
];

const rulerTicks = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];

export const ONBOARDING_METRICS = [
  "onboarding_started",
  "goal_selected",
  "target_submitted",
  "permission_primer_seen",
  "first_preview_started",
  "first_preview_completed",
  "onboarding_completed",
] as const;

function StepDots({ activeIndex }: { activeIndex: number }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Onboarding progress">
      {steps.map((step, index) => {
        const active = index === activeIndex;
        const complete = index < activeIndex;
        return (
          <li key={step.id} className="flex items-center gap-1.5">
            <span
              className={`block h-1.5 rounded-full transition-[width,background-color] duration-300 ${
                active
                  ? "w-12 bg-[var(--sc-text)]"
                  : complete
                    ? "w-5 bg-[var(--sc-accent-500)]"
                    : "w-5 bg-[var(--sc-border-2)]"
              }`}
            />
          </li>
        );
      })}
    </ol>
  );
}

function ArtworkPanel({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="relative grid h-full min-h-0 place-items-center overflow-hidden bg-[var(--sc-chrome-2)] px-8">
      <div className="absolute inset-y-0 left-0 w-px bg-[var(--sc-border)]" />
      <div className="absolute right-8 top-8 hidden h-[calc(100%-64px)] w-10 border-l border-[var(--sc-border-2)] lg:block">
        <div className="mt-2 grid gap-4 pl-3">
          {rulerTicks.map((tick) => (
            <span key={tick} className="h-px w-5 bg-[var(--sc-border-strong)]" />
          ))}
        </div>
      </div>
      <AnimatePresence mode="wait">
        <motion.img
          key={src}
          src={src}
          alt={alt}
          initial={{ opacity: 0, scale: 0.965, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.985, y: -10 }}
          transition={{ type: "spring", stiffness: 120, damping: 24 }}
          className="relative h-auto max-h-[min(74vh,680px)] w-full max-w-[740px] rounded-[34px] object-contain shadow-[var(--sc-sh-3)]"
        />
      </AnimatePresence>
    </div>
  );
}

function MicroSequence() {
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)]">
      {["Write", "Preview", "Record"].map((item, index) => (
        <div key={item} className="border-r border-[var(--sc-border)] px-3 py-3 last:border-r-0">
          <div className="font-mono text-[10px] text-[var(--sc-text-4)]">0{index + 1}</div>
          <div className="mt-2 text-[12px] font-semibold">{item}</div>
        </div>
      ))}
    </div>
  );
}

export default function OnboardingRoute() {
  const navigate = useNavigate();
  const requestNewProject = useDashboardStore((s) => s.requestNewProject);
  const [activeIndex, setActiveIndex] = useState(0);
  const [goalId, setGoalId] = useState(goals[0].id);
  const [targetUrl, setTargetUrl] = useState("");
  const [useSample, setUseSample] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeStep = steps[activeIndex];
  const selectedGoal = goals.find((item) => item.id === goalId) ?? goals[0];
  const artwork = useMemo(() => {
    if (activeStep.id === "outcome") {
      return {
        src: outcomeArtwork,
        alt: "A finished product demo represented as a browser capture and edited video timeline.",
      };
    }
    if (activeStep.id === "goal") {
      return {
        src: selectedGoal.artwork,
        alt: `${selectedGoal.title} onboarding artwork.`,
      };
    }
    if (activeStep.id === "target") {
      return useSample
        ? {
            src: targetSampleArtwork,
            alt: "A sample project pack ready to use without entering a URL.",
          }
        : {
            src: targetUrlArtwork,
            alt: "A product URL being transformed into a starter story.",
          };
    }
    if (activeStep.id === "permissions") {
      return {
        src: permissionsArtwork,
        alt: "A privacy shield representing screen recording and accessibility readiness.",
      };
    }
    return {
      src: previewArtwork,
      alt: "A browser preview run with a cursor path and recording progress.",
    };
  }, [activeStep.id, selectedGoal, useSample]);
  const progress = useMemo(
    () => Math.round(((activeIndex + 1) / steps.length) * 100),
    [activeIndex],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("storycapture:onboarding:v1:started", "true");
  }, []);

  const finish = (openProjectDialog: boolean) => {
    markOnboardingComplete();
    navigate("/", { replace: true });
    if (openProjectDialog) requestNewProject();
  };

  const goNext = () => {
    setError(null);
    if (activeStep.id === "target" && !useSample && !targetUrl.trim()) {
      setError("Paste a URL or use the sample demo.");
      return;
    }
    if (activeIndex === steps.length - 1) {
      finish(true);
      return;
    }
    setActiveIndex((index) => Math.min(index + 1, steps.length - 1));
  };

  const goBack = () => {
    setError(null);
    setActiveIndex((index) => Math.max(index - 1, 0));
  };

  return (
    <main
      id="main-content"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--sc-bg)] text-[var(--sc-text)]"
    >
      <header className="grid h-[68px] shrink-0 grid-cols-[220px_1fr_160px] items-center border-b border-[var(--sc-border)] bg-[var(--sc-chrome)] px-7">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-[var(--sc-text)] text-[var(--sc-text-inverse)]">
            <Film size={17} aria-hidden="true" />
          </div>
          <div>
            <div className="text-[13px] font-semibold">StoryCapture</div>
            <div className="font-mono text-[10.5px] text-[var(--sc-text-4)]">First run</div>
          </div>
        </div>
        <div className="flex justify-center">
          <StepDots activeIndex={activeIndex} />
        </div>
        <button
          type="button"
          className="justify-self-end rounded-full px-3 py-2 text-[12px] text-[var(--sc-text-3)] transition hover:bg-[var(--sc-hover)] active:translate-y-px"
          onClick={() => finish(false)}
        >
          Skip setup
        </button>
      </header>

      <section className="grid min-h-0 flex-1 lg:grid-cols-[minmax(420px,0.9fr)_minmax(480px,1.1fr)]">
        <div className="relative flex min-h-0 flex-col justify-center overflow-hidden px-8 py-7 lg:px-14">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-8 top-8 font-mono text-[128px] font-semibold leading-none text-[var(--sc-border)]"
          >
            {String(activeIndex + 1).padStart(2, "0")}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={activeStep.id}
              initial={{ opacity: 0, x: -18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ type: "spring", stiffness: 140, damping: 24 }}
              className="relative"
            >
              <div className="font-mono text-[11px] uppercase text-[var(--sc-accent-700)]">
                {activeStep.label} / {String(activeIndex + 1).padStart(2, "0")}
              </div>
              <div className="mt-3 max-w-[520px] text-[13px] leading-6 text-[var(--sc-text-3)]">
                {activeStep.eyebrow}
              </div>
              <h1
                className="mt-4 max-w-[560px] text-[42px] font-semibold leading-[0.98] sm:text-[58px]"
                style={{ fontFeatureSettings: '"ss01" 1, "cv01" 1' }}
              >
                {activeStep.title}
              </h1>
            </motion.div>
          </AnimatePresence>

          {activeStep.id === "outcome" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-6 max-w-[470px]"
            >
              <p className="text-[14px] leading-7 text-[var(--sc-text-3)]">
                StoryCapture turns a written story into a real browser recording. First we show the
                loop, then we ask you to create a project.
              </p>
              <div className="mt-5">
                <MicroSequence />
              </div>
            </motion.div>
          )}

          {activeStep.id === "goal" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-7 grid max-w-[620px] gap-2 sm:grid-cols-2"
            >
              {goals.map((item) => {
                const selected = goalId === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setGoalId(item.id)}
                    className={`group relative overflow-hidden rounded-[18px] border p-4 text-left transition duration-300 active:translate-y-px ${
                      selected
                        ? "border-[var(--sc-accent-500)] bg-[oklch(0.78_0.14_var(--sc-accent-h)/0.14)] text-[var(--sc-text)] shadow-[var(--sc-sh-1)]"
                        : "border-[var(--sc-border)] bg-[var(--sc-surface-2)] hover:border-[var(--sc-border-2)] hover:bg-[var(--sc-surface-3)]"
                    }`}
                  >
                    <div
                      className={`absolute right-3 top-3 h-2 w-2 rounded-full ${
                        selected ? "bg-[var(--sc-accent-400)]" : "bg-[var(--sc-text-4)]"
                      }`}
                    />
                    <div className="flex items-center gap-2 pr-5 text-[13px] font-semibold">
                      <Target
                        size={14}
                        className={
                          selected ? "text-[var(--sc-accent-300)]" : "text-[var(--sc-text-3)]"
                        }
                        aria-hidden="true"
                      />
                      {item.title}
                    </div>
                    <div
                      className={`mt-2 text-[12px] leading-5 ${
                        selected ? "text-[var(--sc-text-2)]" : "text-[var(--sc-text-3)]"
                      }`}
                    >
                      {item.body}
                    </div>
                  </button>
                );
              })}
            </motion.div>
          )}

          {activeStep.id === "target" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-7 max-w-[540px]"
            >
              <label className="grid gap-2 text-[13px] font-semibold" htmlFor="onboarding-url">
                Product URL
                <input
                  id="onboarding-url"
                  type="url"
                  value={targetUrl}
                  onChange={(event) => {
                    setTargetUrl(event.target.value);
                    setUseSample(false);
                  }}
                  placeholder="https://app.yourproduct.com/signup"
                  className="h-12 rounded-[16px] border border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-4 text-[13px] font-normal text-[var(--sc-text)] outline-none transition placeholder:text-[var(--sc-text-4)] focus:border-[var(--sc-focus)] focus:bg-[var(--sc-surface)]"
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <ScButton
                  icon={<Sparkles size={13} aria-hidden="true" />}
                  onClick={() => {
                    setUseSample(true);
                    setTargetUrl("");
                    setError(null);
                  }}
                >
                  Use sample
                </ScButton>
                {useSample && <ScBadge tone="success">Sample selected</ScBadge>}
              </div>
              {error && (
                <p role="alert" className="mt-3 text-[12px] text-[var(--sc-record)]">
                  {error}
                </p>
              )}
            </motion.div>
          )}

          {activeStep.id === "permissions" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-7 max-w-[560px] divide-y divide-[var(--sc-border)] overflow-hidden rounded-[20px] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] shadow-[var(--sc-sh-1)]"
            >
              {permissionRows.map(([title, body]) => (
                <div key={title} className="grid gap-1 px-4 py-3.5">
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    <ShieldCheck
                      size={14}
                      className="text-[var(--sc-accent-300)]"
                      aria-hidden="true"
                    />
                    {title}
                  </div>
                  <div className="text-[12px] leading-5 text-[var(--sc-text-3)]">{body}</div>
                </div>
              ))}
            </motion.div>
          )}

          {activeStep.id === "preview" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-7 max-w-[500px]"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--sc-text)] text-[var(--sc-text-inverse)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
                <Play size={18} fill="currentColor" aria-hidden="true" />
              </div>
              <p className="mt-4 text-[14px] leading-7 text-[var(--sc-text-3)]">
                The preview proves the core loop before folder selection. Next, create the local
                project and record the first clip.
              </p>
            </motion.div>
          )}
        </div>

        <ArtworkPanel src={artwork.src} alt={artwork.alt} />
      </section>

      <footer className="grid h-[76px] shrink-0 grid-cols-[160px_1fr_220px] items-center border-t border-[var(--sc-border)] bg-[var(--sc-chrome)] px-7">
        <ScButton
          icon={<ChevronLeft size={13} aria-hidden="true" />}
          disabled={activeIndex === 0}
          onClick={goBack}
        >
          Back
        </ScButton>
        <div className="grid justify-self-center gap-1 text-center">
          <div className="font-mono text-[10.5px] text-[var(--sc-text-4)]">
            {progress}% complete
          </div>
          <div className="h-1 w-[180px] overflow-hidden rounded-full bg-[var(--sc-surface-4)]">
            <div
              className="h-full rounded-full bg-[var(--sc-text)] transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <ScButton
          variant="primary"
          icon={
            activeStep.id === "preview" ? (
              <FolderPlus size={13} aria-hidden="true" />
            ) : (
              <ArrowRight size={13} aria-hidden="true" />
            )
          }
          onClick={goNext}
        >
          {activeStep.id === "preview" ? "Create project" : "Continue"}
        </ScButton>
      </footer>
    </main>
  );
}

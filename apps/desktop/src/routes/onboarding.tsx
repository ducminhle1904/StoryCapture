import { Badge as AstryxBadge } from "@astryxdesign/core/Badge";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { TextInput as AstryxTextInput } from "@astryxdesign/core/TextInput";
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
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
                  ? "w-12 bg-[var(--color-text-primary)]"
                  : complete
                    ? "w-5 bg-[var(--color-accent)]"
                    : "w-5 bg-[var(--color-border-emphasized)]"
              }`}
            />
          </li>
        );
      })}
    </ol>
  );
}

function ArtworkPanel({ src, alt }: { src: string; alt: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="relative grid h-full min-h-0 place-items-center overflow-hidden bg-[var(--color-background-card)] px-8">
      <div className="absolute inset-y-0 left-0 w-px bg-[var(--color-border)]" />
      <div className="absolute right-8 top-8 hidden h-[calc(100%-64px)] w-10 border-l border-[var(--color-border-emphasized)] lg:block">
        <div className="mt-2 grid gap-4 pl-3">
          {rulerTicks.map((tick) => (
            <span key={tick} className="h-px w-5 bg-[var(--color-border-emphasized)]" />
          ))}
        </div>
      </div>
      <AnimatePresence mode="wait">
        <motion.img
          key={src}
          src={src}
          alt={alt}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.965, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, scale: 0.985, y: -10 }}
          transition={{ type: "spring", stiffness: 120, damping: 24 }}
          className="relative h-auto max-h-[min(74vh,680px)] w-full max-w-[740px] rounded-[34px] object-contain shadow-[var(--shadow-high)]"
        />
      </AnimatePresence>
    </div>
  );
}

function MicroSequence() {
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)]">
      {["Write", "Preview", "Record"].map((item, index) => (
        <div key={item} className="border-r border-[var(--color-border)] px-3 py-3 last:border-r-0">
          <div className="font-mono text-[10px] text-[var(--color-text-secondary)]">
            0{index + 1}
          </div>
          <div className="mt-2 text-[12px] font-semibold">{item}</div>
        </div>
      ))}
    </div>
  );
}

export default function OnboardingRoute() {
  const reduceMotion = useReducedMotion();
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
      className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-background-body)] text-[var(--color-text-primary)]"
    >
      <header className="story-window-chrome grid h-[68px] shrink-0 grid-cols-[220px_1fr_160px] items-center border-b border-[var(--color-border)] bg-[var(--story-native-chrome)] px-7">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-[var(--color-text-primary)] text-[var(--color-on-accent)]">
            <Film size={17} aria-hidden="true" />
          </div>
          <div>
            <div className="text-[13px] font-semibold">StoryCapture</div>
            <div className="font-mono text-[10.5px] text-[var(--color-text-secondary)]">
              First run
            </div>
          </div>
        </div>
        <div className="flex justify-center">
          <StepDots activeIndex={activeIndex} />
        </div>
        <AstryxButton
          variant="ghost"
          size="sm"
          className="justify-self-end"
          onClick={() => finish(false)}
          label="Skip setup"
        >
          Skip setup
        </AstryxButton>
      </header>

      <section className="grid min-h-0 flex-1 lg:grid-cols-[minmax(420px,0.9fr)_minmax(480px,1.1fr)]">
        <div className="relative flex min-h-0 flex-col justify-center overflow-hidden px-8 py-7 lg:px-14">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -left-8 top-8 font-mono text-[128px] font-semibold leading-none text-[var(--color-text-secondary)]"
          >
            {String(activeIndex + 1).padStart(2, "0")}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={activeStep.id}
              initial={reduceMotion ? false : { opacity: 0, x: -18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, x: 12 }}
              transition={{ type: "spring", stiffness: 140, damping: 24 }}
              className="relative"
            >
              <div className="font-mono text-[11px] uppercase text-[var(--color-text-accent)]">
                {activeStep.label} / {String(activeIndex + 1).padStart(2, "0")}
              </div>
              <div className="mt-3 max-w-[520px] text-[13px] leading-6 text-[var(--color-text-secondary)]">
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
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-6 max-w-[470px]"
            >
              <p className="text-[14px] leading-7 text-[var(--color-text-secondary)]">
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
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
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
                        ? "border-[var(--color-border-emphasized)] bg-[var(--color-accent-muted)] text-[var(--color-text-primary)] shadow-[var(--shadow-low)]"
                        : "border-[var(--color-border)] bg-[var(--color-background-card)] hover:border-[var(--color-border-emphasized)] hover:bg-[var(--color-background-muted)]"
                    }`}
                  >
                    <div
                      className={`absolute right-3 top-3 h-2 w-2 rounded-full ${
                        selected ? "bg-[var(--color-accent)]" : "bg-[var(--color-text-disabled)]"
                      }`}
                    />
                    <div className="flex items-center gap-2 pr-5 text-[13px] font-semibold">
                      <Target
                        size={14}
                        className={
                          selected
                            ? "text-[var(--color-text-accent)]"
                            : "text-[var(--color-text-secondary)]"
                        }
                        aria-hidden="true"
                      />
                      {item.title}
                    </div>
                    <div
                      className={`mt-2 text-[12px] leading-5 ${
                        selected
                          ? "text-[var(--color-text-secondary)]"
                          : "text-[var(--color-text-secondary)]"
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
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-7 max-w-[540px]"
            >
              <AstryxTextInput
                label="Product URL"
                value={targetUrl}
                onChange={(value) => {
                  setTargetUrl(value);
                  setUseSample(false);
                }}
                placeholder="https://app.yourproduct.com/signup"
                size="lg"
                width="100%"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <AstryxButton
                  icon={<Sparkles size={13} aria-hidden="true" />}
                  onClick={() => {
                    setUseSample(true);
                    setTargetUrl("");
                    setError(null);
                  }}
                  label="Use sample"
                >
                  Use sample
                </AstryxButton>
                {useSample && <AstryxBadge variant="success" label="Sample selected" />}
              </div>
              {error && (
                <p role="alert" className="mt-3 text-[12px] text-[var(--story-recording)]">
                  {error}
                </p>
              )}
            </motion.div>
          )}

          {activeStep.id === "permissions" && (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-7 max-w-[560px] divide-y divide-[var(--color-border)] overflow-hidden rounded-[20px] border border-[var(--color-border)] bg-[var(--color-background-card)] shadow-[var(--shadow-low)]"
            >
              {permissionRows.map(([title, body]) => (
                <div key={title} className="grid gap-1 px-4 py-3.5">
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    <ShieldCheck
                      size={14}
                      className="text-[var(--color-text-accent)]"
                      aria-hidden="true"
                    />
                    {title}
                  </div>
                  <div className="text-[12px] leading-5 text-[var(--color-text-secondary)]">
                    {body}
                  </div>
                </div>
              ))}
            </motion.div>
          )}

          {activeStep.id === "preview" && (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, type: "spring", stiffness: 120, damping: 22 }}
              className="mt-7 max-w-[500px]"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-text-primary)] text-[var(--color-on-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
                <Play size={18} fill="currentColor" aria-hidden="true" />
              </div>
              <p className="mt-4 text-[14px] leading-7 text-[var(--color-text-secondary)]">
                The preview proves the core loop before folder selection. Next, create the local
                project and record the first clip.
              </p>
            </motion.div>
          )}
        </div>

        <ArtworkPanel src={artwork.src} alt={artwork.alt} />
      </section>

      <footer className="grid h-[76px] shrink-0 grid-cols-[160px_1fr_220px] items-center border-t border-[var(--color-border)] bg-[var(--story-native-chrome)] px-7">
        <AstryxButton
          icon={<ChevronLeft size={13} aria-hidden="true" />}
          isDisabled={activeIndex === 0}
          onClick={goBack}
          label="Back"
        >
          Back
        </AstryxButton>
        <div className="grid justify-self-center gap-1 text-center">
          <div className="font-mono text-[10.5px] text-[var(--color-text-secondary)]">
            {progress}% complete
          </div>
          <div className="h-1 w-[180px] overflow-hidden rounded-full bg-[var(--color-background-muted)]">
            <div
              className="h-full rounded-full bg-[var(--color-text-primary)] transition-[width] duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <AstryxButton
          variant="primary"
          icon={
            activeStep.id === "preview" ? (
              <FolderPlus size={13} aria-hidden="true" />
            ) : (
              <ArrowRight size={13} aria-hidden="true" />
            )
          }
          onClick={goNext}
          label={String(activeStep.id === "preview" ? "Create project" : "Continue")}
        >
          {activeStep.id === "preview" ? "Create project" : "Continue"}
        </AstryxButton>
      </footer>
    </main>
  );
}

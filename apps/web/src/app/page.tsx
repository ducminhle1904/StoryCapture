import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { auth } from "@/lib/auth";

const navGroups = [
  {
    label: "Workspace",
    items: ["Projects", "Story Editor", "Post-Production"],
  },
  {
    label: "Output",
    items: ["Render Queue", "Recent Renders"],
  },
  {
    label: "System",
    items: ["Settings"],
  },
];

const steps = [
  {
    number: "01",
    title: "Author",
    body: "Write the flow in plain language or the .story DSL. Keep selectors, assertions, and capture intent in one reviewable source file.",
  },
  {
    number: "02",
    title: "Capture",
    body: "StoryCapture drives a real browser and records native pixels through the desktop engine, with picker and simulator feedback before recording.",
  },
  {
    number: "03",
    title: "Finish",
    body: "Cursor motion, auto-zoom, voiceover, sound, and export presets move into the post-production timeline.",
  },
];

const featureRows = [
  [
    "Author-time preview",
    "Live browser preview, simulator frames, and element picking before a record starts.",
  ],
  [
    "Native capture",
    "ScreenCaptureKit and Windows Graphics Capture paths keep final output crisp.",
  ],
  [
    "Post-production graph",
    "A typed effects graph emits both preview plans and FFmpeg render instructions.",
  ],
  [
    "Share companion",
    "Upload finished demos to workspace pages with embeds, analytics, and desktop sync.",
  ],
];

export default async function HomePage() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[var(--sc-bg)] font-[var(--font-geist)] text-[var(--sc-text)]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,oklch(0.22_0.05_60)_0%,transparent_60%),radial-gradient(ellipse_50%_40%_at_110%_110%,oklch(0.18_0.06_40)_0%,transparent_60%),linear-gradient(180deg,#0b0a09_0%,#050504_100%)]" />

      <header
        className="sc-reveal fixed inset-x-0 top-0 z-20 border-b border-[var(--sc-border)] bg-[var(--sc-chrome)]/86 backdrop-blur-xl"
        style={{ "--sc-delay": "40ms" } as CSSProperties}
      >
        <nav className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark />
            <div>
              <div className="text-[13px] font-semibold tracking-[-0.01em]">StoryCapture</div>
              <div className="mt-px hidden text-[10.5px] text-[var(--sc-text-4)] sm:block">
                Desktop demo automation
              </div>
            </div>
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            <NavLink href="#workflow">Workflow</NavLink>
            <NavLink href="#capabilities">Capabilities</NavLink>
            <NavLink href="#access">Access</NavLink>
          </div>

          <Link
            href="/sign-in"
            className="inline-flex h-8 items-center rounded-[var(--sc-r-md)] border border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-3 text-[12.5px] font-semibold text-[var(--sc-text)] shadow-[var(--sc-sh-1)] transition hover:bg-[var(--sc-hover)] active:translate-y-px"
          >
            Open Web App
          </Link>
        </nav>
      </header>

      <main className="relative">
        <section className="mx-auto grid min-h-[100dvh] max-w-[1180px] items-center gap-10 px-5 pb-20 pt-24 lg:grid-cols-[0.82fr_1.18fr]">
          <div className="max-w-[520px]">
            <div
              className="sc-reveal inline-flex items-center gap-2 rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--sc-text-3)] shadow-[var(--sc-sh-1)]"
              style={{ "--sc-delay": "120ms" } as CSSProperties}
            >
              <span className="sc-status-dot h-1.5 w-1.5 rounded-full bg-[var(--sc-success)]" />
              Private beta for product teams
            </div>

            <h1
              className="sc-reveal mt-6 text-[clamp(42px,5.8vw,70px)] font-semibold leading-[0.98] tracking-[-0.055em] text-[var(--sc-text)]"
              style={{ "--sc-delay": "190ms" } as CSSProperties}
            >
              Write the story.
              <span className="block text-[var(--sc-accent-300)]">Ship the demo.</span>
            </h1>

            <p
              className="sc-reveal mt-6 max-w-[470px] text-[15px] leading-7 text-[var(--sc-text-3)]"
              style={{ "--sc-delay": "280ms" } as CSSProperties}
            >
              StoryCapture turns a script into a finished product video: browser automation, native
              capture, post-production, export, and sharing in one desktop-shaped workflow.
            </p>

            <div
              className="sc-reveal mt-8 flex flex-wrap gap-2.5"
              style={{ "--sc-delay": "360ms" } as CSSProperties}
            >
              <a
                href="#access"
                className="inline-flex h-9 items-center rounded-[var(--sc-r-md)] bg-[var(--sc-accent-400)] px-4 text-[13px] font-semibold text-[var(--sc-text-inverse)] shadow-[var(--sc-sh-2)] transition hover:bg-[var(--sc-accent-300)] active:translate-y-px"
              >
                Request Access
              </a>
              <Link
                href="/sign-in"
                className="inline-flex h-9 items-center rounded-[var(--sc-r-md)] border border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-4 text-[13px] font-semibold text-[var(--sc-text)] shadow-[var(--sc-sh-1)] transition hover:bg-[var(--sc-hover)] active:translate-y-px"
              >
                Sign In
              </Link>
            </div>
          </div>

          <DesktopMock />
        </section>

        <section id="workflow" className="mx-auto max-w-[1180px] px-5 py-20">
          <SectionHeader
            eyebrow="Workflow"
            title="The same loop as the desktop app"
            body="The landing now borrows the app shell directly: compact chrome, warm amber accent, command surfaces, and dense production panels."
          />

          <div className="grid gap-2 md:grid-cols-3">
            {steps.map((step) => (
              <article
                key={step.number}
                className="sc-reveal rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-5 shadow-[var(--sc-sh-1)]"
                style={{ "--sc-delay": `${Number(step.number) * 90}ms` } as CSSProperties}
              >
                <div className="font-[var(--font-geist-mono)] text-[11px] text-[var(--sc-accent-300)]">
                  {step.number}
                </div>
                <h3 className="mt-3 text-[15px] font-semibold">{step.title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-[var(--sc-text-3)]">{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="capabilities" className="mx-auto max-w-[1180px] px-5 py-16">
          <SectionHeader
            eyebrow="Capabilities"
            title="A production tool, not a marketing toy"
            body="The UI should feel like the desktop application because the web companion is part of that same workflow."
          />

          <div className="overflow-hidden rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] shadow-[var(--sc-sh-2)]">
            {featureRows.map(([title, body], index) => (
              <div
                key={title}
                className="sc-reveal grid gap-3 border-b border-[var(--sc-border)] p-5 last:border-b-0 md:grid-cols-[220px_1fr]"
                style={{ "--sc-delay": `${index * 70}ms` } as CSSProperties}
              >
                <div className="flex items-center gap-2">
                  <span className="font-[var(--font-geist-mono)] text-[10.5px] text-[var(--sc-text-4)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="text-[13px] font-semibold">{title}</h3>
                </div>
                <p className="text-[13px] leading-6 text-[var(--sc-text-3)]">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="access" className="mx-auto max-w-[1180px] px-5 pb-24 pt-16">
          <div className="sc-reveal grid gap-4 rounded-[var(--sc-r-xl)] border border-[var(--sc-border)] bg-[var(--sc-surface)] p-5 shadow-[var(--sc-sh-2)] md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="font-[var(--font-geist-mono)] text-[11px] uppercase tracking-[0.08em] text-[var(--sc-accent-300)]">
                Early Access
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em]">
                Bring repeatable demos into your release workflow.
              </h2>
              <p className="mt-2 max-w-[620px] text-[13px] leading-6 text-[var(--sc-text-3)]">
                We are onboarding teams that already write launch flows, QA specs, or developer
                walkthroughs and want those scripts to produce finished videos.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row md:flex-col">
              <Link
                href="/sign-in"
                className="inline-flex h-9 justify-center rounded-[var(--sc-r-md)] bg-[var(--sc-accent-400)] px-4 text-[13px] font-semibold leading-9 text-[var(--sc-text-inverse)] transition hover:bg-[var(--sc-accent-300)] active:translate-y-px"
              >
                Open App
              </Link>
              <a
                href="mailto:hello@storycapture.dev"
                className="inline-flex h-9 justify-center rounded-[var(--sc-r-md)] border border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] px-4 text-[13px] font-semibold leading-9 text-[var(--sc-text)] transition hover:bg-[var(--sc-hover)] active:translate-y-px"
              >
                Contact Team
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative border-t border-[var(--sc-border)] bg-[var(--sc-chrome)]">
        <div className="mx-auto flex max-w-[1180px] flex-col justify-between gap-4 px-5 py-6 text-[12px] text-[var(--sc-text-4)] sm:flex-row">
          <span>StoryCapture desktop and web companion.</span>
          <div className="flex gap-5">
            <a href="#workflow" className="hover:text-[var(--sc-text-2)]">
              Workflow
            </a>
            <a href="#capabilities" className="hover:text-[var(--sc-text-2)]">
              Capabilities
            </a>
            <Link href="/sign-in" className="hover:text-[var(--sc-text-2)]">
              App
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function DesktopMock() {
  return (
    <div className="sc-window-in sc-float overflow-hidden rounded-[12px] border border-[var(--sc-border-2)] bg-[var(--sc-bg)] shadow-[0_0_0_0.5px_rgba(255,255,255,0.14),0_0_0_1px_rgba(0,0,0,0.5),0_40px_120px_rgba(0,0,0,0.6),0_16px_40px_rgba(0,0,0,0.45)]">
      <div className="grid h-10 grid-cols-[80px_1fr_80px] items-center border-b border-[var(--sc-border)] bg-[var(--sc-chrome)] px-3">
        <div className="flex gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="text-center text-[12px] font-semibold text-[var(--sc-text-3)]">
          StoryCapture
        </div>
      </div>

      <div className="grid min-h-[520px] grid-cols-[190px_1fr]">
        <aside className="hidden border-r border-[var(--sc-border)] bg-[var(--sc-chrome)] p-3 md:block">
          <div className="mb-3 flex items-center gap-2">
            <BrandMark />
            <div>
              <div className="text-[12px] font-semibold">StoryCapture</div>
              <div className="text-[10px] text-[var(--sc-text-4)]">v0.4.2 · Tauri</div>
            </div>
          </div>
          <button
            type="button"
            className="mb-4 flex h-8 w-full items-center justify-between rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 text-[11px] text-[var(--sc-text-3)]"
          >
            Search & commands{" "}
            <span className="rounded bg-[var(--sc-surface-3)] px-1.5 py-0.5 font-[var(--font-geist-mono)] text-[10px]">
              K
            </span>
          </button>
          {navGroups.map((group) => (
            <div key={group.label} className="mb-4">
              <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--sc-text-4)]">
                {group.label}
              </div>
              {group.items.map((item, index) => (
                <div
                  key={item}
                  className={`mb-0.5 flex h-7 items-center gap-2 rounded-[var(--sc-r-md)] px-2 text-[12px] ${
                    index === 1 && group.label === "Workspace"
                      ? "bg-[oklch(0.78_0.14_var(--sc-accent-h)/0.12)] text-[var(--sc-accent-300)]"
                      : "text-[var(--sc-text-2)]"
                  }`}
                >
                  <span className="h-3 w-3 rounded-sm border border-current opacity-60" />
                  {item}
                </div>
              ))}
            </div>
          ))}
        </aside>

        <div className="min-w-0 bg-[var(--sc-bg)]">
          <div className="flex h-12 items-center gap-2 border-b border-[var(--sc-border)] px-4">
            <div>
              <div className="text-[14px] font-semibold">Story Editor</div>
              <div className="text-[10.5px] text-[var(--sc-text-4)]">onboarding-flow.story</div>
            </div>
            <span className="flex-1" />
            <span className="rounded-[var(--sc-r-md)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] px-2 py-1 text-[11px] text-[var(--sc-text-3)]">
              Live preview
            </span>
          </div>

          <div className="grid gap-3 p-3 lg:grid-cols-[1fr_0.95fr]">
            <Panel title="Script">
              <div className="relative">
                <span className="sc-caret-scan pointer-events-none absolute left-0 top-[35px] h-[18px] w-px bg-[var(--sc-accent-300)] shadow-[0_0_0_1px_rgba(238,178,65,0.22)]" />
                <CodeLine muted># Onboarding signup flow</CodeLine>
                <CodeLine>
                  <CodeToken>navigate</CodeToken> "https://app.example.test"
                </CodeLine>
                <CodeLine>
                  <CodeToken>click</CodeToken> button "Get Started"
                </CodeLine>
                <CodeLine>
                  <CodeToken>fill</CodeToken> field "Email" with "creator@example.test"
                </CodeLine>
                <CodeLine>
                  <CodeToken>assert</CodeToken> text "Welcome aboard"
                </CodeLine>
              </div>
            </Panel>

            <Panel title="Preview">
              <div className="overflow-hidden rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-text)] text-[var(--sc-text-inverse)]">
                <div className="flex h-7 items-center gap-1.5 border-b border-black/10 bg-[var(--sc-n-100)] px-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--sc-record)]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--sc-warn)]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--sc-success)]" />
                </div>
                <div className="space-y-2 p-4">
                  <div className="h-3 w-2/3 rounded bg-[var(--sc-n-200)]" />
                  <div className="h-20 rounded bg-[var(--sc-n-100)]" />
                  <div className="grid grid-cols-3 gap-2">
                    <div className="h-8 rounded bg-[var(--sc-n-200)]" />
                    <div className="h-8 rounded bg-[var(--sc-accent-300)]" />
                    <div className="h-8 rounded bg-[var(--sc-n-200)]" />
                  </div>
                </div>
              </div>
            </Panel>

            <div className="lg:col-span-2">
              <Panel title="Post-production timeline">
                <div className="space-y-2">
                  {["Video", "Cursor", "Zoom", "Sound"].map((track, index) => (
                    <div key={track} className="grid grid-cols-[70px_1fr] items-center gap-3">
                      <span className="text-[11px] text-[var(--sc-text-4)]">{track}</span>
                      <div className="h-7 rounded-[var(--sc-r-sm)] border border-[var(--sc-border)] bg-[var(--sc-surface-2)] p-1">
                        <div
                          className="sc-track-fill h-full rounded-[var(--sc-r-xs)] bg-[var(--sc-accent-500)]/55"
                          style={{ width: `${76 - index * 11}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="mb-8 max-w-[660px]">
      <p className="font-[var(--font-geist-mono)] text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sc-accent-300)]">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-[clamp(28px,3.6vw,44px)] font-semibold leading-[1.05] tracking-[-0.045em]">
        {title}
      </h2>
      <p className="mt-3 text-[14px] leading-7 text-[var(--sc-text-3)]">{body}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[var(--sc-r-lg)] border border-[var(--sc-border)] bg-[var(--sc-surface)] shadow-[var(--sc-sh-1)]">
      <div className="border-b border-[var(--sc-border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sc-text-4)]">
        {title}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function CodeLine({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <div
      className={`font-[var(--font-geist-mono)] text-[12px] leading-7 ${
        muted ? "text-[var(--sc-text-4)]" : "text-[var(--sc-text-2)]"
      }`}
    >
      {children}
    </div>
  );
}

function CodeToken({ children }: { children: ReactNode }) {
  return <span className="text-[var(--sc-accent-300)]">{children}</span>;
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-[var(--sc-r-md)] px-2 py-1 text-[12.5px] font-medium text-[var(--sc-text-3)] transition hover:bg-[var(--sc-hover)] hover:text-[var(--sc-text)]"
    >
      {children}
    </a>
  );
}

function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] border border-[var(--sc-border-2)] bg-[var(--sc-surface-2)] p-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.35)]"
      style={{ height: size + 8, width: size + 8 }}
    >
      <Image
        src="/assets/ribbon-s-mark-product.png"
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className="select-none rounded-[6px]"
        priority
      />
    </span>
  );
}

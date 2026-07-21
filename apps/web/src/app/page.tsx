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
    title: "Script the demo",
    body: "Write the flow in natural language or the .story DSL. Selectors, assertions, camera intent, and capture timing stay in one reviewable source file.",
  },
  {
    number: "02",
    title: "Automate browser capture",
    body: "StoryCapture drives a real browser, validates the path with preview tools, and records native pixels through the desktop capture engine.",
  },
  {
    number: "03",
    title: "Polish and publish",
    body: "Cursor motion, auto-zoom, voiceover, sound, exports, embeds, and analytics move into a repeatable post-production workflow.",
  },
];

const featureRows = [
  [
    "Script-first demo automation",
    "Turn product walkthrough scripts into repeatable browser runs, so launch demos and onboarding videos do not depend on manual clicking.",
  ],
  [
    "Native desktop capture",
    "ScreenCaptureKit on macOS and Windows Graphics Capture on Windows keep final product demo videos crisp for landing pages, docs, and sales enablement.",
  ],
  [
    "Cinematic post-production",
    "Auto-zoom, cursor emphasis, captions, voiceover timing, export presets, and FFmpeg render instructions are generated from a typed effects graph.",
  ],
  [
    "Web sharing and analytics",
    "Upload finished demos to workspace pages with secure embeds, watch analytics, scene drop-offs, and desktop sync.",
  ],
];

const proofStats = [
  {
    value: "91%",
    label: "of businesses use video as a marketing tool",
    source: "Wyzowl 2026 Video Marketing Statistics",
  },
  {
    value: "39%",
    label: "of video marketers created product demos",
    source: "Wyzowl 2026 Video Marketing Statistics",
  },
  {
    value: "80%",
    label: "of consumers bought or downloaded an app after an app demo video",
    source: "Wyzowl 2026 Video Marketing Statistics",
  },
];

const comparisonRows = [
  [
    "Interactive demo tools",
    "Click-through product tours",
    "Website embeds and guided sales demos",
  ],
  ["Screen recorders", "Manual recording and editing", "One-off videos and quick tutorials"],
  [
    "StoryCapture",
    "Scripted browser automation plus native capture",
    "Repeatable SaaS product demo videos for launches, onboarding, and release notes",
  ],
];

const faqItems = [
  {
    question: "What is StoryCapture?",
    answer:
      "StoryCapture is a script-first product demo video maker for SaaS teams. It turns a written product walkthrough into browser automation, native desktop capture, post-production, export, and web sharing.",
  },
  {
    question: "How is StoryCapture different from interactive demo software?",
    answer:
      "Interactive demo software usually creates click-through tours for website visitors. StoryCapture focuses on producing polished linear videos from repeatable scripted browser flows, which is useful for launches, onboarding, support, and release communication.",
  },
  {
    question: "Who should use a script-first product demo workflow?",
    answer:
      "Product marketers, developer advocates, founders, customer education teams, and release teams should use it when they need the same demo to be recreated consistently as the product changes.",
  },
  {
    question: "Does StoryCapture replace a screen recorder?",
    answer:
      "StoryCapture overlaps with screen recording, but it adds browser automation, author-time preview, native capture, cinematic editing, export presets, and share analytics so teams can move from rough recording to publishable demo video.",
  },
];

const siteUrl = "https://story-capture-web.vercel.app";
const jsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "StoryCapture",
    url: siteUrl,
    logo: `${siteUrl}/assets/ribbon-s-mark-product.png`,
    description:
      "StoryCapture builds desktop and web software for creating repeatable product demo videos from scripted browser flows.",
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "StoryCapture",
    applicationCategory: "MultimediaApplication",
    operatingSystem: "macOS, Windows, Web",
    url: siteUrl,
    image: `${siteUrl}/assets/storycapture-hero-product.png`,
    description:
      "A script-first product demo video maker for SaaS teams that automates browser flows, captures native pixels, applies post-production, exports video, and shares demos online.",
    featureList: [
      "Scripted browser automation for product walkthroughs",
      "Native macOS and Windows screen capture",
      "Author-time preview and element picking",
      "Auto-zoom, cursor emphasis, voiceover, and export presets",
      "Secure web sharing, embeds, analytics, and workspace sync",
    ],
    offers: {
      "@type": "Offer",
      availability: "https://schema.org/PreOrder",
      price: "0",
      priceCurrency: "USD",
    },
    author: {
      "@type": "Organization",
      name: "StoryCapture",
      url: siteUrl,
    },
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  },
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Product Demo Video Maker for SaaS Teams - StoryCapture",
    description:
      "StoryCapture turns scripted browser flows into polished product demo videos for SaaS launches, onboarding, support, and release communication.",
    url: siteUrl,
    datePublished: "2026-04-25",
    dateModified: "2026-04-25",
    inLanguage: "en-US",
    isPartOf: {
      "@type": "WebSite",
      name: "StoryCapture",
      url: siteUrl,
    },
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: ["h1", ".geo-summary", ".geo-faq"],
    },
  },
];
const structuredData = JSON.stringify(jsonLd);

export default async function HomePage() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[var(--color-background-body)] font-[var(--font-family-body)] text-[var(--color-text-primary)]">
      <script type="application/ld+json">{structuredData}</script>
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,oklch(0.22_0.05_60)_0%,transparent_60%),radial-gradient(ellipse_50%_40%_at_110%_110%,oklch(0.18_0.06_40)_0%,transparent_60%),linear-gradient(180deg,#0b0a09_0%,#050504_100%)]" />

      <header
        className="story-reveal fixed inset-x-0 top-0 z-20 border-b border-[var(--color-border)] bg-[var(--story-native-chrome)]/86 backdrop-blur-xl"
        style={{ "--story-entry-delay": "40ms" } as CSSProperties}
      >
        <nav className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <BrandMark />
            <div>
              <div className="text-[13px] font-semibold tracking-[-0.01em]">StoryCapture</div>
              <div className="mt-px hidden text-[10.5px] text-[var(--color-text-secondary)] sm:block">
                Desktop demo automation
              </div>
            </div>
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            <NavLink href="#workflow">Workflow</NavLink>
            <NavLink href="#capabilities">Capabilities</NavLink>
            <NavLink href="#research">Market</NavLink>
            <NavLink href="#faq">FAQ</NavLink>
            <NavLink href="#access">Access</NavLink>
          </div>

          <Link
            href="/sign-in"
            className="inline-flex h-8 items-center rounded-[var(--radius-element)] border border-[var(--color-border-emphasized)] bg-[var(--color-background-card)] px-3 text-[12.5px] font-semibold text-[var(--color-text-primary)] shadow-[var(--shadow-low)] transition hover:bg-[var(--color-overlay-hover)] active:translate-y-px"
          >
            Open Web App
          </Link>
        </nav>
      </header>

      <main className="relative">
        <section className="mx-auto grid min-h-[100dvh] max-w-[1180px] items-center gap-10 px-5 pb-20 pt-24 lg:grid-cols-[0.82fr_1.18fr]">
          <div className="max-w-[520px]">
            <div
              className="story-reveal inline-flex items-center gap-2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-card)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-secondary)] shadow-[var(--shadow-low)]"
              style={{ "--story-entry-delay": "120ms" } as CSSProperties}
            >
              <span className="story-status-dot h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
              Private beta for SaaS product teams
            </div>

            <h1
              className="story-reveal mt-6 text-[clamp(42px,5.8vw,70px)] font-semibold leading-[0.98] tracking-[-0.055em] text-[var(--color-text-primary)]"
              style={{ "--story-entry-delay": "190ms" } as CSSProperties}
            >
              Product demo video maker.
              <span className="block text-[var(--color-text-accent)]">
                Scripted from the start.
              </span>
            </h1>

            <p
              className="geo-summary story-reveal mt-6 max-w-[500px] text-[15px] leading-7 text-[var(--color-text-secondary)]"
              style={{ "--story-entry-delay": "280ms" } as CSSProperties}
            >
              StoryCapture turns scripted browser flows into polished SaaS product demo videos:
              automation, native screen capture, cinematic post-production, export, and web sharing
              in one repeatable workflow.
            </p>

            <div
              className="story-reveal mt-8 flex flex-wrap gap-2.5"
              style={{ "--story-entry-delay": "360ms" } as CSSProperties}
            >
              <a
                href="#access"
                className="inline-flex h-9 items-center rounded-[var(--radius-element)] bg-[var(--color-accent)] px-4 text-[13px] font-semibold text-[var(--color-on-accent)] shadow-[var(--shadow-med)] transition hover:bg-[var(--color-text-accent)] active:translate-y-px"
              >
                Request Beta Access
              </a>
              <Link
                href="/sign-in"
                className="inline-flex h-9 items-center rounded-[var(--radius-element)] border border-[var(--color-border-emphasized)] bg-[var(--color-background-card)] px-4 text-[13px] font-semibold text-[var(--color-text-primary)] shadow-[var(--shadow-low)] transition hover:bg-[var(--color-overlay-hover)] active:translate-y-px"
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
            title="From product script to publishable video"
            body="StoryCapture is built for teams that need repeatable demo automation, not another one-off recording. Author the story, validate the browser path, capture native pixels, then export a finished walkthrough."
          />

          <div className="grid gap-2 md:grid-cols-3">
            {steps.map((step) => (
              <article
                key={step.number}
                className="story-reveal rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-5 shadow-[var(--shadow-low)]"
                style={{ "--story-entry-delay": `${Number(step.number) * 90}ms` } as CSSProperties}
              >
                <div className="font-[var(--font-family-code)] text-[11px] text-[var(--color-text-accent)]">
                  {step.number}
                </div>
                <h3 className="mt-3 text-[15px] font-semibold">{step.title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                  {step.body}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section id="capabilities" className="mx-auto max-w-[1180px] px-5 py-16">
          <SectionHeader
            eyebrow="Capabilities"
            title="Demo automation software for real browser flows"
            body="Interactive demo tools are useful for click-through tours. StoryCapture focuses on linear product demo videos that can be recreated every release from the same script."
          />

          <div className="overflow-hidden rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] shadow-[var(--shadow-med)]">
            {featureRows.map(([title, body], index) => (
              <div
                key={title}
                className="story-reveal grid gap-3 border-b border-[var(--color-border)] p-5 last:border-b-0 md:grid-cols-[220px_1fr]"
                style={{ "--story-entry-delay": `${index * 70}ms` } as CSSProperties}
              >
                <div className="flex items-center gap-2">
                  <span className="font-[var(--font-family-code)] text-[10.5px] text-[var(--color-text-secondary)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="text-[13px] font-semibold">{title}</h3>
                </div>
                <p className="text-[13px] leading-6 text-[var(--color-text-secondary)]">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="research" className="mx-auto max-w-[1180px] px-5 py-16">
          <SectionHeader
            eyebrow="Market proof"
            title="Product demo videos are now a buying asset"
            body="The search intent is clear: teams want product demo software that lowers editing time, keeps demos current, and produces assets good enough for landing pages, onboarding, sales, docs, and launch announcements."
          />

          <div className="grid gap-3 md:grid-cols-3">
            {proofStats.map((stat, index) => (
              <article
                key={stat.value}
                className="story-reveal rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-5 shadow-[var(--shadow-low)]"
                style={{ "--story-entry-delay": `${index * 80}ms` } as CSSProperties}
              >
                <div className="font-[var(--font-family-code)] text-[32px] font-semibold tracking-[-0.04em] text-[var(--color-text-accent)]">
                  {stat.value}
                </div>
                <p className="mt-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                  {stat.label}
                </p>
                <p className="mt-3 text-[11px] text-[var(--color-text-secondary)]">{stat.source}</p>
              </article>
            ))}
          </div>

          <div className="mt-5 overflow-hidden rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] shadow-[var(--shadow-med)]">
            <div className="grid border-b border-[var(--color-border)] px-5 py-3 font-[var(--font-family-code)] text-[10.5px] uppercase tracking-[0.08em] text-[var(--color-text-secondary)] md:grid-cols-[220px_1fr_1fr]">
              <span>Category</span>
              <span className="hidden md:block">Primary workflow</span>
              <span className="hidden md:block">Best fit</span>
            </div>
            {comparisonRows.map(([category, workflow, fit]) => (
              <div
                key={category}
                className="grid gap-2 border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 md:grid-cols-[220px_1fr_1fr]"
              >
                <h3 className="text-[13px] font-semibold">{category}</h3>
                <p className="text-[13px] leading-6 text-[var(--color-text-secondary)]">
                  {workflow}
                </p>
                <p className="text-[13px] leading-6 text-[var(--color-text-secondary)]">{fit}</p>
              </div>
            ))}
          </div>

          <p className="mt-4 max-w-[760px] text-[12px] leading-6 text-[var(--color-text-secondary)]">
            Source:{" "}
            <a
              href="https://wyzowl.com/video-marketing-statistics/"
              className="text-[var(--color-text-accent)] underline decoration-[var(--color-text-secondary)] underline-offset-2 hover:text-[var(--color-text-primary)]"
              rel="noopener noreferrer"
              target="_blank"
            >
              Wyzowl Video Marketing Statistics 2026
            </a>
            . StoryCapture uses this market signal to focus the product on fast, repeatable,
            high-quality app demo video production.
          </p>
        </section>

        <section id="faq" className="geo-faq mx-auto max-w-[1180px] px-5 py-16">
          <SectionHeader
            eyebrow="FAQ"
            title="Product demo video maker questions"
            body="Direct answers for teams comparing demo automation software, interactive demo tools, and screen recording workflows."
          />

          <div className="grid gap-2 md:grid-cols-2">
            {faqItems.map((item, index) => (
              <article
                key={item.question}
                className="story-reveal rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-5 shadow-[var(--shadow-low)]"
                style={{ "--story-entry-delay": `${index * 70}ms` } as CSSProperties}
              >
                <h3 className="text-[15px] font-semibold tracking-[-0.02em]">{item.question}</h3>
                <p className="mt-3 text-[13px] leading-6 text-[var(--color-text-secondary)]">
                  {item.answer}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section id="access" className="mx-auto max-w-[1180px] px-5 pb-24 pt-16">
          <div className="story-reveal grid gap-4 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] p-5 shadow-[var(--shadow-med)] md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="font-[var(--font-family-code)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-text-accent)]">
                Early Access
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em]">
                Bring repeatable product demo videos into your release workflow.
              </h2>
              <p className="mt-2 max-w-[620px] text-[13px] leading-6 text-[var(--color-text-secondary)]">
                We are onboarding teams that already write launch flows, QA specs, onboarding
                scripts, or developer walkthroughs and want those scripts to produce finished
                videos.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row md:flex-col">
              <Link
                href="/sign-in"
                className="inline-flex h-9 justify-center rounded-[var(--radius-element)] bg-[var(--color-accent)] px-4 text-[13px] font-semibold leading-9 text-[var(--color-on-accent)] transition hover:bg-[var(--color-text-accent)] active:translate-y-px"
              >
                Open Web App
              </Link>
              <a
                href="mailto:hello@storycapture.dev"
                className="inline-flex h-9 justify-center rounded-[var(--radius-element)] border border-[var(--color-border-emphasized)] bg-[var(--color-background-card)] px-4 text-[13px] font-semibold leading-9 text-[var(--color-text-primary)] transition hover:bg-[var(--color-overlay-hover)] active:translate-y-px"
              >
                Contact Team
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="relative border-t border-[var(--color-border)] bg-[var(--story-native-chrome)]">
        <div className="mx-auto flex max-w-[1180px] flex-col justify-between gap-4 px-5 py-6 text-[12px] text-[var(--color-text-secondary)] sm:flex-row">
          <span>StoryCapture product demo video maker and web companion.</span>
          <div className="flex gap-5">
            <a href="#workflow" className="hover:text-[var(--color-text-secondary)]">
              Workflow
            </a>
            <a href="#capabilities" className="hover:text-[var(--color-text-secondary)]">
              Capabilities
            </a>
            <a href="#faq" className="hover:text-[var(--color-text-secondary)]">
              FAQ
            </a>
            <Link href="/sign-in" className="hover:text-[var(--color-text-secondary)]">
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
    <div className="story-window-in story-float overflow-hidden rounded-[12px] border border-[var(--color-border-emphasized)] bg-[var(--color-background-body)] shadow-[0_0_0_0.5px_rgba(255,255,255,0.14),0_0_0_1px_rgba(0,0,0,0.5),0_40px_120px_rgba(0,0,0,0.6),0_16px_40px_rgba(0,0,0,0.45)]">
      <div className="grid h-10 grid-cols-[80px_1fr_80px] items-center border-b border-[var(--color-border)] bg-[var(--story-native-chrome)] px-3">
        <div className="flex gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="text-center text-[12px] font-semibold text-[var(--color-text-secondary)]">
          StoryCapture
        </div>
      </div>

      <div className="grid min-h-[520px] grid-cols-[190px_1fr]">
        <aside className="hidden border-r border-[var(--color-border)] bg-[var(--story-native-chrome)] p-3 md:block">
          <div className="mb-3 flex items-center gap-2">
            <BrandMark />
            <div>
              <div className="text-[12px] font-semibold">StoryCapture</div>
              <div className="text-[10px] text-[var(--color-text-secondary)]">v0.4.2 · Tauri</div>
            </div>
          </div>
          <div
            aria-hidden="true"
            className="mb-4 flex h-8 w-full items-center justify-between rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-card)] px-2 text-[11px] text-[var(--color-text-secondary)]"
          >
            Search & commands{" "}
            <span className="rounded bg-[var(--color-background-muted)] px-1.5 py-0.5 font-[var(--font-family-code)] text-[10px]">
              K
            </span>
          </div>
          {navGroups.map((group) => (
            <div key={group.label} className="mb-4">
              <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-secondary)]">
                {group.label}
              </div>
              {group.items.map((item, index) => (
                <div
                  key={item}
                  className={`mb-0.5 flex h-7 items-center gap-2 rounded-[var(--radius-element)] px-2 text-[12px] ${
                    index === 1 && group.label === "Workspace"
                      ? "bg-[var(--color-accent-muted)] text-[var(--color-text-accent)]"
                      : "text-[var(--color-text-secondary)]"
                  }`}
                >
                  <span className="h-3 w-3 rounded-sm border border-current opacity-60" />
                  {item}
                </div>
              ))}
            </div>
          ))}
        </aside>

        <div className="min-w-0 bg-[var(--color-background-body)]">
          <div className="flex h-12 items-center gap-2 border-b border-[var(--color-border)] px-4">
            <div>
              <div className="text-[14px] font-semibold">Story Editor</div>
              <div className="text-[10.5px] text-[var(--color-text-secondary)]">
                onboarding-flow.story
              </div>
            </div>
            <span className="flex-1" />
            <span className="rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-card)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]">
              Live preview
            </span>
          </div>

          <div className="grid gap-3 p-3 lg:grid-cols-[1fr_0.95fr]">
            <Panel title="Script">
              <div className="relative">
                <span className="story-caret-scan pointer-events-none absolute left-0 top-[35px] h-[18px] w-px bg-[var(--color-text-accent)] shadow-[0_0_0_1px_rgba(238,178,65,0.22)]" />
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
              <div className="overflow-hidden rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-text-primary)] text-[var(--color-on-accent)]">
                <div className="flex h-7 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-text-primary)] px-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--story-recording)]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" />
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
                </div>
                <div className="space-y-2 p-4">
                  <div className="h-3 w-2/3 rounded bg-[var(--color-text-primary)]" />
                  <div className="h-20 rounded bg-[var(--color-text-primary)]" />
                  <div className="grid grid-cols-3 gap-2">
                    <div className="h-8 rounded bg-[var(--color-text-primary)]" />
                    <div className="h-8 rounded bg-[var(--color-text-accent)]" />
                    <div className="h-8 rounded bg-[var(--color-text-primary)]" />
                  </div>
                </div>
              </div>
            </Panel>

            <div className="lg:col-span-2">
              <Panel title="Post-production timeline">
                <div className="space-y-2">
                  {["Video", "Cursor", "Zoom", "Sound"].map((track, index) => (
                    <div key={track} className="grid grid-cols-[70px_1fr] items-center gap-3">
                      <span className="text-[11px] text-[var(--color-text-secondary)]">
                        {track}
                      </span>
                      <div className="h-7 rounded-[var(--radius-inner)] border border-[var(--color-border)] bg-[var(--color-background-card)] p-1">
                        <div
                          className="story-track-fill h-full rounded-[var(--radius-inner)] bg-[var(--color-accent)]/55"
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
      <p className="font-[var(--font-family-code)] text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-accent)]">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-[clamp(28px,3.6vw,44px)] font-semibold leading-[1.05] tracking-[-0.045em]">
        {title}
      </h2>
      <p className="mt-3 text-[14px] leading-7 text-[var(--color-text-secondary)]">{body}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)] shadow-[var(--shadow-low)]">
      <div className="border-b border-[var(--color-border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
        {title}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function CodeLine({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <div
      className={`font-[var(--font-family-code)] text-[12px] leading-7 ${
        muted ? "text-[var(--color-text-secondary)]" : "text-[var(--color-text-secondary)]"
      }`}
    >
      {children}
    </div>
  );
}

function CodeToken({ children }: { children: ReactNode }) {
  return <span className="text-[var(--color-text-accent)]">{children}</span>;
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-[var(--radius-element)] px-2 py-1 text-[12.5px] font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-overlay-hover)] hover:text-[var(--color-text-primary)]"
    >
      {children}
    </a>
  );
}

function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] border border-[var(--color-border-emphasized)] bg-[var(--color-background-card)] p-[3px] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.35)]"
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

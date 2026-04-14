# Feature Research

**Domain:** Demo video / product walkthrough / automated screencast (desktop-first, dev/PM audience)
**Researched:** 2026-04-14
**Confidence:** HIGH (for table stakes and competitor features — all cross-verified against live product pages); MEDIUM (for anti-feature judgments — opinionated but grounded in scope constraints in PROJECT.md)

## Competitive Landscape Snapshot

| Tool | Core Approach | Primary Audience | Format |
|------|---------------|------------------|--------|
| **Screen Studio** | Record → auto-polish (zoom, cursor, backgrounds) | Content creators, marketers | macOS native, video |
| **Tella** | Multi-scene recorder + layouts + backgrounds | Creators, founders, async comms | Web + desktop, video |
| **Arcade** | Click-capture → HTML/screenshot interactive demo | Sales, PMM | Browser ext + web, interactive |
| **Supademo** | Capture → interactive click-through demo | Sales, onboarding | Browser ext + web, interactive |
| **Scribe** | Auto-capture → annotated step-by-step doc | Ops, support, SOPs | Browser ext, doc (not video) |
| **Loom** | Simple record → share w/ AI transcript + trim | Everyone (async messaging) | Multi-platform, video |
| **Demo Time (VSCode ext)** | Script-driven live coding presentations | Dev speakers, streamers | VSCode, in-editor (not video) |
| **Runway** | AI video generation / editing | Creative pros | Web, video |
| **Playwright trace / video** | Test videos as a byproduct | Developers / QA | CLI, raw video |

StoryCapture's positioning: **"Demo Time for the full browser, rendered as a Screen Studio-quality video, authored in a DSL (or via AI)."** No one else combines (a) script-first reproducibility, (b) real browser automation, and (c) cinematic post-production in a single desktop app.

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these means the output looks amateur next to Screen Studio / Tella and users will churn within the first session.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Auto-zoom on clicks / actions** | Screen Studio set the bar; every demo tool now does it. Without it, videos feel static and unreadable at 1080p. | MEDIUM | Detect click events from automation (no CV needed — we know coords), generate ease-in/ease-out zoom keyframes. FFmpeg `zoompan` or per-frame transform. |
| **Smooth cursor movement** | Screen Studio interpolates jittery motion into fluid glides. Users assume this. | MEDIUM | We own the automation, so we have exact source/target coords → Bezier-interpolate between clicks. Easier than CV-based smoothing. |
| **Click ripples / highlight rings** | Industry standard (Screen Studio, Tella, Rekort, Screenize). | LOW | Overlay a radial-gradient PNG/SVG animation at click timestamps. FFmpeg `overlay` filter or compositor. |
| **Rounded corners + padded backgrounds** | Screen Studio popularized the "wallpaper + rounded browser window" look. Sales/marketing demos expect it. | LOW | Wrap captured frame in a mask + gradient/image background. Pre-render or real-time. |
| **Multi-format export (MP4, WebM, GIF)** | Baseline for any video tool. | LOW | FFmpeg handles all three. GIF needs palettegen pass. |
| **Resolution / FPS / quality presets** | 1080p/1440p/4K, 30/60fps. Defaults aren't enough. | LOW | FFmpeg params; just a UI concern. |
| **Trim / cut (even if minimal)** | Even script-driven tools need a "remove this section" affordance post-capture. | MEDIUM | Timeline scrub + in/out points; re-render the segment range. |
| **Shareable link with viewer page** | Loom, Tella, Arcade, Supademo, Scribe — all auto-host. Users expect "upload and share" in one click. | HIGH | Web companion (Next.js) + S3/R2 + share page. Already committed in PROJECT.md. |
| **Cursor visibility controls** | Show/hide/resize cursor; auto-hide when idle. Screen Studio spec. | LOW | Since we draw the cursor as overlay (not captured from OS), we fully control it. |
| **Text overlays / captions** | Every tool has labels. Needed for step narration. | MEDIUM | Timeline-based overlay track with font/size/color/position. |
| **Scene transitions** | xfade / dissolve between scenes/cuts. | LOW | FFmpeg `xfade` filter; already in PROJECT.md. |
| **Light "cleanup" of captured input** | Blur sensitive fields, hide URLs, etc. Arcade's Redaction Tool is now standard for sales use-cases. | MEDIUM | Bounding-box blur overlay by selector or manual region. |
| **Background music / sound bed** | Demo videos almost always have a subtle loop. | LOW | Bundled royalty-free library + user-provided audio tracks; FFmpeg mix. |
| **Preview before export** | Real-time (or near-real-time) preview of the post-prod composition. | HIGH | Probably the hardest table-stakes feature. Needs a preview renderer distinct from final export. |
| **Re-record individual scenes** | Can't re-shoot the whole thing for a 5-second flub. | MEDIUM | Scene granularity in DSL already enables this — run one `scene` block against saved page state. |
| **Project persistence / open-again** | "Where's my recording from yesterday?" | LOW | SQLite + per-project folders; already in PROJECT.md. |

### Differentiators (Competitive Advantage)

These are where StoryCapture **wins**. Each aligns with the Core Value ("turn a written story into a polished video").

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Story DSL as the source of truth** | The demo is **text**: diffable, reviewable in PRs, version-controlled. No competitor has this. Demo Time scripts VSCode; StoryCapture scripts a real browser + video. | HIGH | pest-based parser already committed. Critical that DSL stays readable — close to natural language, not Gherkin-heavy. |
| **Reproducible recordings** | Re-run the same story against a new build → new video, same framing. Kills the "marketing has to re-record every release" problem. | MEDIUM | Falls out of DSL + automation for free; requires stable selector strategy. |
| **Natural-language → DSL authoring** | Chat-style "click the login button, then enter email" → DSL. Removes the DSL-learning-curve objection. Nobody else has LLM-authored scripted demos. | MEDIUM | LLM round-trip with diff preview; already in PROJECT.md. Key UX decision: always show the generated DSL, never hide it. |
| **Smart selector engine with fallback chain** | text → testid → aria → CSS with auto-retry. Means stories don't break when UI shifts. Playwright has this; demo tools don't. | MEDIUM | Borrow Playwright's locator heuristics; build on top. |
| **Real browser automation (not screenshot capture)** | Arcade/Supademo capture static HTML snapshots; clicks are simulated. StoryCapture drives a real browser → real animations, real async states, real responsive behavior. | HIGH | chromiumoxide + Playwright sidecar. |
| **DSL-driven scene granularity** | Each `scene` block = a re-recordable unit. Maps 1:1 to the timeline. No other tool has scene-as-source-concept. | LOW | Emerges from DSL + timeline UI. |
| **AI voiceover synced to DSL steps** | Because each step is structured, we can auto-time TTS to actions. ElevenLabs-quality narration, auto-synced. Loom has TTS; none auto-sync to scripted actions. | MEDIUM | TTS API + step-duration alignment; in PROJECT.md. |
| **Offline-first, local-only** | Loom/Tella/Arcade/Supademo are cloud-only. For enterprise/security-sensitive demos, local-only is a hard requirement. | LOW | Just don't upload by default; web companion is opt-in. |
| **Dev-native output (DSL in Git)** | PR reviewer can see "the demo changed this way" as a text diff. Enables a "docs-as-code" workflow for demo videos. | LOW | Just write `.story` files to disk; nothing more needed. |
| **Deterministic timing / wait-for semantics** | `wait-for selector` vs. fragile `sleep(2000)`. Tests-quality reliability for demos. | MEDIUM | Standard Playwright-style waits. |
| **CI-friendly architecture (headless render)** | Even if CLI ships in Phase 5 (per PROJECT.md), architecture should support "render this story headless." Competitor tools are GUI-only; StoryCapture becoming a build artifact generator is a category-defining move. | MEDIUM | Keep render pipeline stateless and scriptable from day one, even if UI ships first. |
| **Template marketplace for stories** | "Login flow," "checkout flow," "SaaS onboarding" as starter templates. Shorter time-to-first-video than starting blank. | MEDIUM | Web companion concern; in PROJECT.md. |
| **Branded export presets (org-level)** | Wallpaper + font + logo + lower-third = one-click brand. Screen Studio has per-user presets; org-level is rarer. | LOW | JSON preset + optional org sync. |
| **Multi-viewport / responsive recording** | Record the same story at mobile + tablet + desktop widths in one pass. A natural superpower of browser automation. | MEDIUM | Loop over viewport list; emit N videos. |

### Anti-Features (Commonly Requested, Often Problematic)

Things users will ask for. Deliberately say no (or defer) — each one either kills the product's focus or duplicates work better tools already do.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Full video NLE (multi-track audio, keyframe animation, color grading)** | Users want "just one more editing feature" and suddenly we're competing with DaVinci Resolve. | Scope death. Auto-post-prod is the value prop; heavy manual editing contradicts it. | Export to MP4; tell users to finish in Descript/Premiere if they need NLE-level polish. |
| **Real-time multi-user collaborative editing** | "Google Docs for demos." Sounds great; CRDT complexity is enormous. | CRDT + live cursors + conflict resolution = 6-month project on its own. Deferred in PROJECT.md to Phase 5 — **keep it there**. | Git-based collaboration on `.story` files. Diffs and PRs are the workflow. |
| **Mobile app recording (iOS/Android screen capture)** | "Can I record my iOS app?" | Requires native iOS/Android capture stacks, USB tethering, or simulator integration. 4x platform work. | Record a mobile emulator / responsive browser viewport. |
| **Native app automation (macOS AX, Windows UIA) in v1** | "What about my Electron app?" / "What about Figma desktop?" | Each platform's a/11y API is its own rabbit hole. Selectors don't transfer. | Deferred in PROJECT.md to Phase 5. Encourage users to run Electron apps in dev-tools mode OR use browser version. |
| **Full-featured interactive click-through demos (à la Arcade)** | "Can users click through instead of just watching?" | That's a different product (HTML-snapshot platform). Would force web-rendered output and compete on Arcade's home turf. | Stay video-first. Later: `--interactive` export to HTML5 player with pause-points — but NOT a click-through SaaS. |
| **Real-time voice narration recording during capture** | "Can I talk while it records?" | Undermines reproducibility. A re-run would lose the voice. Forces editing workflow for audio. | TTS voiceover (already committed) — re-generates on re-run. Let users bring their own recorded audio as a separate track if they insist. |
| **Webcam / picture-in-picture recording** | Tella's signature feature; users coming from Tella will ask. | Webcam ties a recording to a person → breaks reproducibility. | Out of scope; a Tella-style "creator" tool is a different product. Document as a non-goal. |
| **Full LMS / course-authoring (quizzes, branching, progress tracking)** | "Can I turn a demo into a course?" | Distinct product category (Articulate, Rise, Storyline). | Export clean videos; users embed in their LMS of choice. |
| **Built-in analytics dashboards beyond basics** | "Who watched? Heatmaps? Conversion funnels?" | Full product-analytics stack is a months-long build. | Ship view counts + watch-through on web companion. Integrate with Plausible/PostHog for advanced needs. |
| **Chromium-less automation (Firefox/Safari drivers)** | Some users want to demo on "real Safari." | chromiumoxide is Chromium-only. Cross-browser doubles automation surface. | Use Chrome with device emulation; real Safari out of scope. |
| **AI auto-generation of the demo from the product URL alone** | "Just crawl my site and make a demo." | Too much ambiguity — which flow? what story? LLM-only generation produces bland demos. | LLM **assists** authoring (already in scope); doesn't replace intent. |
| **Plugin system for user-contributed effects in v1** | Power users want to add custom effects. | Security (sandboxing), API stability, docs overhead. | Deferred to Phase 5 in PROJECT.md. Ship great defaults first. |
| **Cloud rendering / render farm** | "My laptop takes 30s to render." | Bandwidth + GPU infra + billing. Not in Phase 1. | Hardware-accelerated local encode is already the plan (VideoToolbox/NVENC/QSV). |
| **Live streaming (Twitch/YouTube output)** | "Can I stream the demo live?" | OBS exists. Different pipeline (realtime encoder, RTMP). | Recommend OBS + export MP4 for VODs. |
| **Linux desktop build in v1** | "Why not Linux?" | Native capture + code-signing + install matrix. | Excluded in PROJECT.md. Revisit after v1 product-market fit. |

## Feature Dependencies

```
Story DSL parser
    └──enables──> Browser automation
                      └──enables──> Screen capture (deterministic timing)
                                         └──enables──> Post-production pipeline
                                                            ├──enables──> Auto-zoom (uses click coords from automation)
                                                            ├──enables──> Smooth cursor (uses automation path)
                                                            ├──enables──> Click ripples (timed from action log)
                                                            └──enables──> Text overlays

Story DSL parser
    └──enables──> DSL → scene granularity
                      └──enables──> Re-record single scene
                      └──enables──> Timeline layer tracks

Smart selector engine ──enhances──> Reproducibility
                      ──enhances──> CI/CD headless (Phase 5)

Natural-language → DSL ──enhances──> Story DSL authoring UX
(requires DSL parser to exist; generates DSL as output)

AI voiceover ──requires──> DSL step timing (sync target)
             ──requires──> TTS API integration

Shareable web links ──requires──> Next.js companion
                    ──requires──> Desktop ↔ web sync
                    ──requires──> Upload / storage (S3/R2)

Multi-viewport export ──requires──> Deterministic render pipeline
                      ──enhances──> Reproducibility differentiator

Template marketplace ──requires──> Web companion + auth
                     ──requires──> Stable DSL version (v1 lock-in)

Full NLE features  ──conflicts──> Auto-post-prod value prop
                    (adding one creates pressure to add all)

Real-time collab   ──conflicts──> Offline-first / local-only value prop
```

### Dependency Notes

- **Automation drives everything cinematic:** Because StoryCapture *authors* the clicks, it *knows* where the cursor went and when. Every auto-zoom/smooth-cursor/click-ripple feature becomes dramatically simpler than in a tool that has to infer from captured pixels (Screen Studio's engineering achievement). This is a structural advantage — exploit it.
- **DSL parser is the tent pole:** Nothing after it works without a working DSL. First-phase priority.
- **Post-production needs a rendering abstraction:** Don't couple post-prod logic to the GUI. Once decoupled, Phase 5 CLI mode falls out almost for free.
- **Web companion can lag desktop:** Shareable links and templates are table stakes in the category but can ship v1.1. Local-only mode is genuinely usable alone.

## MVP Definition

### Launch With (v1) — The "Can Make One Polished Demo Video" Cut

Minimum set that validates "DSL + automation + polish > manual recording."

- [ ] **Story DSL parser** with scene/meta + core actions (navigate, click, type, wait, wait-for, assert, screenshot, scroll, hover) — *differentiator bedrock*
- [ ] **Browser automation** (chromiumoxide, with Playwright sidecar fallback) — *enables everything*
- [ ] **Platform-native screen capture** (macOS + Windows) — *quality floor*
- [ ] **FFmpeg post-production pipeline:** auto-zoom, smooth cursor, click ripples, rounded window, background, transitions — *table stakes cluster, non-negotiable*
- [ ] **Multi-format export** (MP4, WebM, GIF) with presets — *table stakes*
- [ ] **Story editor UI** (CodeMirror + preview + selector autocomplete) — *the primary author surface*
- [ ] **Timeline preview + scene re-record** — *table stakes + DSL differentiator showcase*
- [ ] **Smart selector engine with fallback** — *differentiator; also prevents v1 from feeling flaky*
- [ ] **Project persistence** (SQLite + per-project folders) — *table stakes*
- [ ] **Natural-language → DSL authoring** — *reduces DSL adoption friction; the "wow" demo moment*

### Add After Validation (v1.x)

- [ ] **AI voiceover (TTS) synced to DSL** — trigger: users asking "how do I add narration?" (they will, quickly)
- [ ] **Web companion: upload + shareable links + embed** — trigger: "how do I send this to my team?"
- [ ] **Template gallery / starter stories** — trigger: new-user onboarding data shows time-to-first-video > 20 min
- [ ] **Redaction / blur tool** — trigger: sales-team users asking about sensitive data
- [ ] **Multi-viewport recording** — trigger: first request from a mobile-responsive product team
- [ ] **Organization-level branded export presets** — trigger: paid-tier sign-ups hit 50+

### Future Consideration (v2+ / deferred per PROJECT.md)

- [ ] **Headless CLI / CI mode** — wait until DSL is stable; needs careful exit-code + artifact design
- [ ] **Native app automation (AX / UIA)** — only if browser coverage is genuinely insufficient after v1
- [ ] **Diff-aware re-recording** — sophisticated; needs v1 usage data to know where changes typically bite
- [ ] **Plugin system** — only after effects catalog is stable (premature plugins ossify bad APIs)
- [ ] **Localization re-run engine** — interesting but niche; defer
- [ ] **Real-time collaborative editing** — maybe never; Git-based collab might be enough
- [ ] **Mobile screen recording** — separate product
- [ ] **Interactive click-through export** — different product category; only if market demands it

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| DSL parser | HIGH | HIGH | P1 |
| Browser automation | HIGH | HIGH | P1 |
| Native screen capture | HIGH | HIGH | P1 |
| Auto-zoom / smooth cursor / click ripples | HIGH | MEDIUM | P1 |
| Rounded window + backgrounds | HIGH | LOW | P1 |
| Multi-format export | HIGH | LOW | P1 |
| Story editor UI + preview | HIGH | HIGH | P1 |
| Scene re-record | HIGH | MEDIUM | P1 |
| Smart selector engine | HIGH | MEDIUM | P1 |
| Natural-language → DSL | HIGH | MEDIUM | P1 |
| Project persistence | MEDIUM | LOW | P1 |
| Text overlays | MEDIUM | MEDIUM | P1 |
| Scene transitions | MEDIUM | LOW | P1 |
| Trim / cut UI | MEDIUM | MEDIUM | P1 |
| Sound / BGM mixer | MEDIUM | LOW | P1 |
| AI voiceover (TTS) | HIGH | MEDIUM | P2 |
| Web companion (share / embed) | HIGH | HIGH | P2 |
| Template marketplace | MEDIUM | MEDIUM | P2 |
| Redaction tool | MEDIUM | MEDIUM | P2 |
| Multi-viewport export | MEDIUM | MEDIUM | P2 |
| Branded org presets | MEDIUM | LOW | P2 |
| Webcam PiP | LOW | MEDIUM | P3 / NO |
| Real-time collab | LOW | HIGH | P3 / NO (v1) |
| Native app automation | MEDIUM | HIGH | P3 |
| Cloud rendering | LOW | HIGH | P3 / NO |
| Linux build | LOW | HIGH | NO |
| Mobile recording | LOW | HIGH | NO |

## Competitor Feature Analysis

| Feature | Screen Studio | Tella | Arcade / Supademo | Scribe | Demo Time (VSCode) | StoryCapture Approach |
|---------|--------------|-------|-------------------|--------|---------------------|------------------------|
| **Auto-zoom on click** | Best-in-class; post-hoc tuning | Yes, basic | Snapshot-based (no video zoom needed) | N/A (static) | N/A | Compute from known click coords → cleaner keyframes than CV-based |
| **Smooth cursor** | Post-hoc smoothing of jittery input | Basic | N/A | N/A | N/A | Bezier-interpolate between scripted coords → smoother than Screen Studio by construction |
| **Click ripples** | Yes | Yes | Yes (on snapshots) | Yes (annotations) | N/A | Yes; overlay composited at exact action timestamps |
| **Rounded window + backgrounds** | Signature feature | Strong (1000s of BGs) | Snapshot frame | No | N/A | Yes; ship 20+ curated backgrounds + custom upload |
| **Multi-scene layouts (webcam, split)** | Yes | Signature feature | No | No | No | **No** — anti-feature (webcam breaks reproducibility) |
| **Trim / cut editing** | Yes | Yes | N/A | N/A | N/A | Yes, minimal |
| **Shareable link / hosted viewer** | Upload only | Yes | Yes (core) | Yes (core) | No | Yes, via Next.js companion (v1.x) |
| **AI voiceover / TTS** | No (external) | Limited | Yes (Arcade) | No | No | Yes, synced to DSL steps |
| **AI transcription** | Yes | Yes | N/A | N/A | N/A | Not v1 priority (TTS matters more than STT here) |
| **Script-driven / reproducible** | **No** | **No** | **No** (snapshot-baked) | **No** | **Yes** (code only, no video) | **Yes** — uniquely combined with video output |
| **Real browser automation** | **No** | **No** | Limited (click-capture only) | **No** | **No** | **Yes** (chromiumoxide) |
| **DSL / text source of truth** | **No** | **No** | **No** | **No** | **Yes** (JSON/YAML) | **Yes** (pest DSL; human-authored preferred) |
| **Natural-language authoring** | **No** | **No** | Some AI helpers | AI captions | **No** | **Yes** (LLM → DSL with diff) |
| **Redaction / blur** | Manual | Manual | Yes (Arcade AI) | Yes (Pro) | N/A | Yes, selector-based (v1.x) |
| **Multi-viewport recording** | **No** | **No** | **No** | **No** | **No** | **Yes** (unique — differentiator) |
| **Offline-first / local-only** | Partial (local edit, cloud upload) | **No** | **No** | **No** | Yes (editor-local) | **Yes** (explicit commitment) |
| **Platform** | macOS only | macOS + Windows | Web-centric | Browser ext | VSCode | **macOS + Windows desktop** |

### Strategic Reading

- **Screen Studio is the polish benchmark** — match it on table stakes or users notice. The good news: our structural advantage (knowing click coords a priori) makes parity easier than it was for Screen Studio.
- **Arcade/Supademo compete on sales use-cases** — they'll always win the "interactive click-through for prospects" market. Do not chase; stay video-first.
- **Scribe owns docs** — do not drift into SOP generation. Our output is video, not annotated screenshots.
- **Tella owns creators** — do not chase webcam/PiP. Different audience.
- **Demo Time owns the scripted niche** — but only for VSCode live coding. StoryCapture extends the "scripted demo" idea to real product UIs + video. **This is the white space.**
- **Loom owns async messaging** — commodity recording; not our fight.

## Key Feature-Design Principles for Roadmap

1. **Every post-prod feature should exploit automation-derived metadata.** We know click coords, timings, selector identities. Don't reinvent CV-based inference — that's the hard path competitors took out of necessity.
2. **DSL first, UI second.** If a feature exists only in the GUI, it can't be reproduced, committed, or LLM-generated. Every editor action should round-trip through the DSL.
3. **Preview fidelity is a quality gate.** "Looks right in preview, wrong in export" is a category-wide pain. Budget accordingly.
4. **Polish defaults > configurability.** Screen Studio's reputation is built on "the defaults are already the video you wanted." Match that ethos — deep config is fine, but the zero-config output should be demo-ready.
5. **Anti-feature discipline is a feature.** Every "just add webcam" or "just add CRDT collab" is a vote against the DSL+reproducibility thesis. The "Out of Scope" list in PROJECT.md is a competitive moat; treat it as such.

## Sources

- [Screen Studio — Auto Zoom guide](https://screen.studio/guide/auto-zoom) — HIGH confidence, official docs
- [Screen Studio review (2026)](https://scribehow.com/page/Screen_Studio_Review_2026__Best_Mac_Screen_Recorder__pkHh5vHIQjaHUuE0qxv8bw) — MEDIUM
- [macOS zoom & annotation tools 2026 (DEV Community)](https://dev.to/dave_lee_f99c54a1688d407b/ive-been-recording-coding-tutorials-for-10-years-heres-my-comparison-of-every-macos-screen-zoom-3opf) — MEDIUM, practitioner comparison
- [Rekort — Cursor highlight & click effects guide](https://rekort.app/blog/screen-recording-cursor-click-effects) — MEDIUM
- [Tella — Multi-layouts](https://www.tella.com/features/multi-layouts) — HIGH, official
- [Tella — Custom backgrounds](https://www.tella.com/features/custom-backgrounds) — HIGH, official
- [Arcade — Best interactive demo software 2026](https://www.arcade.software/post/best-interactive-demo-software-2026) — MEDIUM (vendor post)
- [Supademo — Arcade alternatives](https://supademo.com/blog/arcade-alternatives) — MEDIUM (vendor post; cross-reference for feature lists)
- [Supademo vs Arcade vs SmartCue comparison](https://www.getsmartcue.com/blog/supademo-vs-arcade-vs-smartcue) — MEDIUM
- [Scribe — Step recorder](https://scribe.com/tools/step-recorder-software) — HIGH, official
- [Scribe — Annotation tools](https://scribe.com/tools/annotation-tools) — HIGH, official
- [Loom — AI screen recorder](https://www.loom.com/products/ai-screen-recorder) — HIGH, official
- [Loom AI features (Atlassian support)](https://support.loom.com/hc/en-us/articles/11331500832157-Loom-AI-features) — HIGH, official
- [Demo Time (GitHub)](https://github.com/estruyf/vscode-demo-time) — HIGH, primary source
- [Demo Time docs](https://demotime.show/) — HIGH, official
- [Playwright videos](https://playwright.dev/docs/videos) — HIGH, official
- [Headless Recorder / DeploySentinel discussion (HN)](https://news.ycombinator.com/item?id=30362244) — MEDIUM, community
- `.planning/PROJECT.md` — primary scope source

---
*Feature research for: automated demo-video / product-walkthrough desktop tool*
*Researched: 2026-04-14*

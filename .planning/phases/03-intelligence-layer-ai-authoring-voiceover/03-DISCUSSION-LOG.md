# Phase 3: Intelligence Layer — AI Authoring & Voiceover - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-15
**Phase:** 03 — Intelligence Layer — AI Authoring & Voiceover
**Mode:** discuss (interactive, Vietnamese)
**Areas discussed:** LLM strategy, NL-Mode chat UX, TTS + voiceover sync, LSP architecture

---

## Gray-area selection

| Option | Description | Selected |
|--------|-------------|----------|
| LLM strategy | Provider, model, adapter, caching, cost guards | ✓ |
| NL-Mode chat UX (UI-07) | Layout, diff, iterate, history | ✓ |
| TTS + voiceover sync | Provider, voice catalog, sync rule, cache | ✓ |
| LSP architecture | Host, diagnostic scope, selector UX | ✓ |

**User's choice:** All four areas.

---

## LLM Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Anthropic-first | Claude Sonnet 4.6 default; OpenAI fallback; prompt caching strong | ✓ |
| OpenAI-first | GPT-4o/4.1 default; Claude fallback | |
| Both parallel from day 1 | User picks per Settings | |
| BYO-only, no default | User must paste own key first | |

| Option | Description | Selected |
|--------|-------------|----------|
| Trait `LlmProvider` from day 1 | Two impls in `crates/intelligence`; mirrors BrowserDriver | ✓ |
| Hardcode 1 provider, refactor later | Faster ship, refactor risk later | |
| Use third-party SDK wrapper (rig/genai) | Pre-1.0 dependency risk | |

| Option | Description | Selected |
|--------|-------------|----------|
| Both prompt caching + streaming | Cache 5× cheaper for system prompt; SSE streams diff | ✓ |
| Streaming only | Simpler; higher cost per token | |
| Caching only, batch | No real-time diff render | |

| Option | Description | Selected |
|--------|-------------|----------|
| Soft warning + per-session counter | Estimate before big call; status-bar counter; no block | ✓ |
| Hard cap budget per project | Persist counter; block when over | |
| No guardrail | User manages on provider dashboard | |
| Backoff-only on 429 | No cost tracking | |

**Notes:** All four answers = recommended option.

---

## NL-Mode Chat UX (UI-07)

| Option | Description | Selected |
|--------|-------------|----------|
| Side panel right alongside DSL editor | ~65/35 split, collapse-able; Cursor/Zed pattern | ✓ |
| Full-screen NL Mode toggle | Chat center, diff right; non-dev friendly | |
| Two layouts (toggle) | Editor-mode + author-mode; double effort | |
| Modal popup overlay | Blocks editor while chatting | |

| Option | Description | Selected |
|--------|-------------|----------|
| Per-step block + inline diff | Cards aligned to DSL steps; per-step approve/edit/regen/reject | ✓ |
| Full-file diff | Single accept-all/reject-all only | |
| Patch hunks (git-style) | Hunks misalign DSL step boundaries | |

| Option | Description | Selected |
|--------|-------------|----------|
| Inline edit + send-back | User edits step in card OR replies; LLM regen only that step | ✓ |
| Reject → LLM regen entire file | Token-heavy but simpler | |
| Reject = drop step, no regen | AI sketches only; user writes replacement manually | |

| Option | Description | Selected |
|--------|-------------|----------|
| Per-project in `project.sqlite` | New `nl_conversations` table; survives reload | ✓ |
| Per-session in-memory only | Lost on close; misses success criteria | |
| Per-project + auto-summarize | Sustainable for big projects; extra complexity | |

| Option | Description | Selected |
|--------|-------------|----------|
| Grammar + DSL + history (no extras) | Predictable cost; no vision/DOM | ✓ |
| Add page screenshot when navigate URL | Better selector accuracy; high cost | |
| Add DOM/accessibility tree | Most accurate selectors; needs live browser | |
| Minimal: prompt + grammar only | Cheapest; iteration painful | |

**Notes:** All recommended. User explicitly chose to defer richer LLM context (screenshot/DOM) for v2.

---

## TTS + Voiceover Sync (AI-02, AI-03)

| Option | Description | Selected |
|--------|-------------|----------|
| ElevenLabs first | Cinematic voice quality; multi-language; OpenAI fallback | ✓ |
| OpenAI TTS first | Cheaper, lower latency, fewer voices | |
| Both parallel from day 1 | Per-project provider switcher | |

| Option | Description | Selected |
|--------|-------------|----------|
| Bundled curated set + browse provider | 6-8 named presets mapped to voice IDs; "Browse all" opens raw catalog | ✓ |
| Bundled only | Simpler; less flexible | |
| Raw provider catalog only | Power-user friendly; overwhelming for non-dev | |

| Option | Description | Selected |
|--------|-------------|----------|
| LLM generates script from DSL + step labels | Re-uses Anthropic provider; user edits before TTS | ✓ |
| Template-based (label/comment as script) | No LLM cost; raw script quality | |
| User writes script from scratch | Misses AI-02 "auto-script from DSL" | |

| Option | Description | Selected |
|--------|-------------|----------|
| Step duration stretches to TTS (TTS = ground truth) | Pause/freeze when TTS longer; silence padding when shorter | ✓ |
| Time-stretch TTS to fit step | ±10% acceptable; voice distortion risk | |
| Overflow to next step | Timeline becomes confusing | |
| Per-step user choice (mixed) | Flexible; lots of UI | |

| Option | Description | Selected |
|--------|-------------|----------|
| Hash(script + voice + provider) cache | Reuse when unchanged; GC after 1 week | ✓ |
| Whole-voiceover cache, regen all on any change | Token-expensive on small edits | |
| No cache | Highest cost per preview | |

**Notes:** All recommended. Sync rule (TTS = ground truth) was an important call — keeps voiceover natural even if it forces step re-pacing.

---

## LSP Architecture (AI-06) + Dry-Run (AI-04)

| Option | Description | Selected |
|--------|-------------|----------|
| In-process Rust `tower-lsp` over Tauri IPC | Share `crates/story-parser`; low latency; no sidecar process | ✓ |
| Sidecar process via stdio JSON-RPC | Standard LSP shape; sidecar mgmt + extra binary | |
| Pure JS LSP shim in webview | Reimplements grammar; drift risk | |

| Option | Description | Selected |
|--------|-------------|----------|
| Grammar + semantic offline | Parse errors + undefined verb + selector heuristics + step-order warnings | ✓ |
| Grammar errors only (minimal) | Misses "LSP-powered" promise | |
| Live browser checks real-time | Slow; complex; needs running browser | |

| Option | Description | Selected |
|--------|-------------|----------|
| Inline gutter marker + hover popover | ⚠️ icon per step; popover shows fallback chain | ✓ |
| Dedicated "Selector Health" panel | Power-user list view | |
| Both gutter + panel | Most complete; effort heavy | |

| Option | Description | Selected |
|--------|-------------|----------|
| Inline per-step status + summary panel | Real-time gutter colors during dry-run + bottom panel summary | ✓ |
| Console log stream only | Hard to map to step | |
| Toast at end + log file | No live feedback | |
| Inline-only, no panel | Minimal UI | |

**Notes:** All recommended. In-process LSP is the more opinionated choice (rejects classic LSP sidecar shape) — chosen for parser-sharing and latency.

---

## Closing question

| Option | Description | Selected |
|--------|-------------|----------|
| Ready to write CONTEXT.md — Claude decides API key UX | Claude's Discretion captured in CONTEXT.md | ✓ |
| Discuss API key UX (1-2 questions) | Decide explicitly | |
| Discuss other gray areas | Error/recovery, telemetry-off, multi-language input | |

---

## Claude's Discretion (captured in CONTEXT.md)

- API key onboarding (Settings → Accounts shared page; cheap test call to validate; global per provider).
- Empty/error states for NL Mode (loading skeleton, retry, rate-limit fallback).
- Optional Selector Health panel (planner judgment if low effort).
- CodeMirror LSP plumbing choice (`@codemirror/lsp` vs custom extension).
- Telemetry off for AI calls (no third-party beyond chosen provider).
- Multi-language input pass-through; voice catalog shows locale meta when provider exposes it.

## Deferred Ideas (captured in CONTEXT.md)

See `03-CONTEXT.md` `<deferred>` section.

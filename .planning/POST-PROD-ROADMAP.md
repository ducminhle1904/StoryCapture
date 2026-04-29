# Post-Production E2E Roadmap

**Drafted:** 2026-04-28
**Context:** Phase 18 + 19 shipped real-video preview, computeGraph plumbing, typed Clip union, trajectory recording, and Story → Timeline auto-population. End-to-end is NOT yet ship-ready — gaps documented below.

## What's done

| Phase | Scope | Status |
|---|---|---|
| Wave 1 (post-prod review fixes) | Encoder hardening, parity test, persist export form, generic add-clip undo, track UI affordance | ✅ shipped |
| Phase 18 | Real video preview wiring + computeGraph plumbing | ✅ shipped (with caveat: graph empty in prod until producer existed) |
| Phase 19-01 | Typed Clip discriminated union | ✅ shipped |
| Phase 19-02 | Trajectory recording sidecar + IPC | ✅ shipped (no click events yet) |
| Phase 19-03 | Story → Timeline producer + auto-population | ✅ shipped (video + cursor only) |

## Critical gaps to ship E2E

| Phase | Title | Blocker level | Effort | Depends on |
|---|---|---|---|---|
| **20** | Cursor overlay render fix | 🔴 BLOCKER | 2-3h | none |
| **21** | E2E export verification | 🔴 BLOCKER | 1-2h + operator | 20 |
| **22** | Cinematic editing UI | 🟡 UX gap | 8-12h | none (parallel to 20/21) |
| **23** | Click events + auto-zoom | 🟢 enhancement | 3-4h | 19-02 |
| **24** | E2E integration test in CI | 🟢 quality | 2-3h | 20 |
| **25** | Post-prod polish | 🟢 polish | 2-3h | 22 |

## Sequence + dependencies

```
[20 cursor fix]──→[21 E2E verify]──→[24 CI test]
       │                                    │
       │                                    │
       └──────────→[25 polish]              │
                                            │
[22 cinematic UI]───────────────────────────┘
       │                                    │
       │                                    │
[23 click + auto-zoom]──────────────────────┘
```

- **Critical path**: 20 → 21 → 24 — must be sequential. ~6h total + operator.
- **Parallel tracks**:
  - 22 cinematic UI (independent, gates UX value)
  - 23 click events (independent of 20/21/22)
  - 25 polish (after 22, since some polish items are UI-side)

## Operator-blocking work (separate from coding)

- **02-08 audio curation**: 20 CC0/CC-BY-4.0 audio files (12 SFX + 8 BGM), normalized to -16 LUFS, listen-test checklist passed. Required to unblock sound track value + 5 ignored tests in `crates/effects/tests/sound_library.rs`. See `.planning/phases/02-cinematic-post-production-export/02-08-RESUME.md`. **No code work.**
- **02-12b walkthrough**: 5-step manual UAT (scrub 60fps, presets, export MP4/WebM/GIF, undo, a11y). See `.planning/phases/02-cinematic-post-production-export/02-12b-RESUME.md`. **Re-runnable after Phase 21 verifies E2E.**

## Total estimate

- **Critical path (20+21+24)**: ~6-8h coding + 1-2h operator UAT.
- **UX completeness (22)**: +8-12h.
- **Enhancement (23)**: +3-4h.
- **Polish (25)**: +2-3h.

**Code total: ~20-30h. Operator: 02-08 audio + 02-12b + 21 verify.**

## Recommended order of execution

1. **Phase 20** — close the cursor render mismatch. Without this, every "cursor overlay" claim is hollow.
2. **Phase 21** — operator runs an actual E2E export. Surface bugs no code review will find.
3. **In parallel from now:**
   - Phase 22 — cinematic UI (zoom, annotation, background, transitions). Largest UX value.
   - Phase 23 — click events + auto-zoom (rounds out 19-02 and 19-03's deferred features).
4. **Phase 24** — once 20+21 land, wire E2E test in CI to prevent regression.
5. **Phase 25** — last-mile polish. Optional if shipping under time pressure.

## Out of scope for these phases

- Headless / CI render of the same graph (Option B from Phase 19's architecture decision)
- Multi-recording timeline (single recording per project today)
- LLM-derived smart annotations
- Custom cursor skins beyond the 5 bundled (mac-default, win-default, dark, light, big-arrow)
- Real-time collaboration on post-prod editor

## File index

- `phases/20-cursor-overlay-render-fix/20-PLAN.md` — cursor render fix (4 plans)
- `phases/21-e2e-export-verification/21-PLAN.md` — operator E2E verify (2 plans)
- `phases/22-cinematic-editing-ui/22-PLAN.md` — zoom/annotation/background/transition UI (4 plans)
- `phases/23-click-events-auto-zoom/23-PLAN.md` — OS click hooks + auto-zoom heuristic (2 plans)
- `phases/24-e2e-integration-test-ci/24-PLAN.md` — synthetic record→export test (2 plans)
- `phases/25-post-prod-polish/25-PLAN.md` — bag of nice-to-haves (5 items)

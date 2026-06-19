# Post-Production E2E Roadmap

> Current planning artifact for Phase 20-25 post-production follow-up. Validate
> file paths against the current Electron/TypeScript source tree before acting;
> older linked phase docs may still mention removed Tauri/Rust paths.

**Drafted:** 2026-04-28
**Refreshed:** 2026-05-06
**Context:** Phase 18 + 19 shipped real-video preview, computeGraph plumbing, typed Clip union, trajectory recording, and Story → Timeline auto-population. Follow-up quick work added hybrid Editor UI / Code mode, polish sidecars, Record & Polish, step timing sidecars, review fix-list surfacing, extra design-system primitives, and May 4-6 export hardening. End-to-end still needs operator verification and CI coverage.

## What's done

| Phase | Scope | Status |
|---|---|---|
| Wave 1 (post-prod review fixes) | Encoder hardening, parity test, persist export form, generic add-clip undo, track UI affordance | ✅ shipped |
| Phase 18 | Real video preview wiring + computeGraph plumbing | ✅ shipped (with caveat: graph empty in prod until producer existed) |
| Phase 19-01 | Typed Clip discriminated union | ✅ shipped |
| Phase 19-02 | Trajectory recording sidecar + IPC | ✅ shipped |
| Phase 19-03 | Story → Timeline producer + auto-population | ✅ shipped |
| Phase 20 | Cursor overlay render fix | ✅ source present: export pre-processes `.trajectory.json` / `.actions.json` into cursor PNG sequences |
| Quick 260501-g26 | Hybrid Editor UI mode + polish sidecar + Record & Polish | ✅ shipped |
| Quick 260501-ku1/l88 | Accurate record timing sidecars + review fix-list | ✅ shipped |
| Quick 260501-dse | Design-system primitive enhancements | ✅ shipped |
| May 4-6 export hardening | Backend boundary, interrupted-render cancellation, progress stabilization, match-source hardening, direct MP4 color/fps fixes, highlight preprocessing | ✅ source present |

## Critical gaps to ship E2E

| Phase | Title | Blocker level | Effort | Depends on |
|---|---|---|---|---|
| **21** | E2E export verification | 🔴 BLOCKER | 1-2h + operator | source fixes present; operator UAT needed |
| **24** | E2E integration test in CI | 🟡 quality | 2-3h | 21 |
| **22** | Cinematic editing UI | 🟡 UX gap | 8-12h | can proceed in parallel |
| **23** | Click events + auto-zoom | 🟡 partly shipped | remaining polish TBD | actions/timing sidecars present |
| **25** | Post-prod polish | 🟢 polish | 2-3h | 21/22 findings |

## Sequence + dependencies

```
[20 source present]──→[21 E2E verify]──→[24 CI test]
                          │
                          └──→[25 polish]

[22 cinematic UI]──────────────┘
[23 remaining auto-zoom polish]┘
```

- **Critical path**: 21 → 24. Phase 20 code is now present in source; Phase 21
  still needs a real record/export run to validate it.
- **Parallel tracks**:
  - 22 cinematic UI (independent, gates UX value)
  - 23 remaining auto-zoom/click polish if operator feedback shows gaps
  - 25 polish after Phase 21/22 findings clarify priority

## Operator-blocking work (separate from coding)

- **02-08 audio curation**: 20 CC0/CC-BY-4.0 audio files (12 SFX + 8 BGM), normalized to -16 LUFS, listen-test checklist passed. Required to unblock real sound track value; older ignored-test references in linked Phase 02 docs point at removed Rust crate paths. See `.planning/phases/02-cinematic-post-production-export/02-08-RESUME.md`. **No code work.**
- **02-12b walkthrough**: 5-step manual UAT (scrub 60fps, presets, export MP4/WebM/GIF, undo, a11y). See `.planning/phases/02-cinematic-post-production-export/02-12b-RESUME.md`. **Re-runnable after Phase 21 verifies E2E.**

## Total estimate

- **Critical path (21+24)**: ~3-5h coding + 1-2h operator UAT.
- **UX completeness (22)**: +8-12h.
- **Enhancement (23)**: +3-4h.
- **Polish (25)**: +2-3h.

**Code total: ~15-25h depending on Phase 21 findings. Operator: 02-08 audio +
02-12b + 21 verify.**

## Recommended order of execution

1. **Phase 21** — operator runs an actual E2E export. Surface bugs no code
   review will find.
2. **Phase 24** — once Phase 21 passes or produces bounded fixes, wire E2E
   coverage in CI.
3. **In parallel from now:**
   - Phase 22 — cinematic UI (zoom, annotation, background, transitions). Largest UX value.
   - Phase 23 — remaining auto-zoom/click polish, if still needed after the
     2026-05-01 timing-sidecar work.
4. **Phase 25** — last-mile polish. Optional if shipping under time pressure.

## Out of scope for these phases

- Headless / CI render of the same graph (Option B from Phase 19's architecture decision)
- Multi-recording timeline (single recording per project today)
- LLM-derived smart annotations
- Custom cursor skins beyond the 5 bundled (mac-default, win-default, dark, light, big-arrow)
- Real-time collaboration on post-prod editor

## File index

- `phases/20-cursor-overlay-render-fix/20-PLAN.md` — original cursor render fix plan; source now contains the core fix
- `phases/21-e2e-export-verification/21-PLAN.md` — operator E2E verify (2 plans)
- `phases/22-cinematic-editing-ui/22-PLAN.md` — zoom/annotation/background/transition UI (4 plans)
- `phases/23-click-events-auto-zoom/23-PLAN.md` — OS click hooks + auto-zoom heuristic (2 plans)
- `phases/24-e2e-integration-test-ci/24-PLAN.md` — synthetic record→export test (2 plans)
- `phases/25-post-prod-polish/25-PLAN.md` — bag of nice-to-haves (5 items)

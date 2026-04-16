---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 19
subsystem: desktop-frontend
tags: [react, zustand, tts, voice-catalog, script-editor, vitest, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/11
    provides: tts_generate, tts_voice_list, tts_regenerate_clip Tauri commands
  - phase: 03-intelligence-layer-ai-authoring-voiceover/12
    provides: TTS voiceover sync engine (compute_sync_plan, tts_apply_sync)
provides:
  - VoiceCatalogDialog modal with curated/expanded modes and locale filter
  - VoicePresetCard with preview button, conic-gradient ring, Featured badge
  - TtsScriptEditor per-step script editor with char count, cost estimate, dirty tracking
  - TtsClipInspector with duration, cost, cache status, regenerate CTA
  - Zustand voiceoverStore for catalog state, filters, clip tracking, generation progress
  - useTts hook wiring tts_generate / tts_voice_list / tts_regenerate_clip Tauri IPC
affects:
  - Phase 3 eval harness (Plan 21) -- can verify voiceover UI renders correctly
  - Phase 2 sound track integration -- TTS clips ready for timeline placement
tech-stack:
  added: []
  patterns:
    - "Zustand store with Set<string> for tracking concurrent generation state per stepId"
    - "HTMLAudioElement preview playback with onerror handler (T-03-19-01)"
    - "Conic-gradient CSS animation ring for voice preview playing state (2.4s linear)"
    - "Featured badge cap enforcement (max 2) via sequential counter in useMemo"
    - "Controlled textarea with Zustand store for dirty tracking (edited-after-gen state)"
key-files:
  created:
    - apps/desktop/src/features/voiceover/voiceoverStore.ts
    - apps/desktop/src/features/voiceover/useTts.ts
    - apps/desktop/src/features/voiceover/VoiceCatalogDialog.tsx
    - apps/desktop/src/features/voiceover/VoicePresetCard.tsx
    - apps/desktop/src/features/voiceover/TtsScriptEditor.tsx
    - apps/desktop/src/features/voiceover/TtsClipInspector.tsx
    - apps/desktop/src/features/voiceover/VoiceCatalogDialog.test.tsx
    - apps/desktop/src/features/voiceover/TtsScriptEditor.test.tsx
  modified: []
key-decisions:
  - "MockAudio class pattern for testing HTMLAudioElement preview -- vi.stubGlobal with class definition instead of vi.fn().mockImplementation for proper constructor semantics"
  - "Unicode escape sequences in JSX expressions for Vietnamese copy -- consistent with Plan 17/18 pattern for happy-dom test compatibility"
  - "Featured badge enforcement via sequential counter in useMemo rather than store validation -- simpler, UI-only concern"
  - "Cost rate hardcoded at $0.30/1K chars (ElevenLabs default) in script editor -- matches AI-SPEC section 4 pricing"
requirements-completed: [AI-02]
duration: ~8 min
completed: 2026-04-16
---

# Phase 03 Plan 19: Voice Catalog + TTS Script Editor UI Summary

**Voice catalog modal with curated/expanded modes (720x560/960x720), locale filter chips, 8-voice grid with Featured badge cap, per-step TTS script editor with char count + cost estimate + dirty tracking, clip inspector with 5 timeline states, and 12 Vitest tests.**

## Performance

- **Duration:** ~8 min
- **Tasks:** 2 (both TDD)
- **Commits:** 2 (`25dfe26` catalog + store, `48e9d50` script editor + inspector)
- **Files created:** 8 (6 source + 2 test)
- **Files modified:** 0

## What Was Built

**Task 1 -- VoiceCatalogDialog + VoicePresetCard + voiceoverStore + useTts hook.**

- **`voiceoverStore.ts`** -- Zustand store tracking: `selectedPreset`, `catalogOpen`, `catalogMode` (curated/expanded), `filter` (locale/premium), `clipByStepId`, `generating` (Set<string>), `scriptByStepId`, `editedAfterGenByStepId`. Actions for all state mutations.
- **`useTts.ts`** -- Hook wiring `tts_generate`, `tts_voice_list`, `tts_regenerate_clip` via `invoke`. Preview method creates `HTMLAudioElement` with `onerror` handler (T-03-19-01 mitigation). Hard-coded sample text "This is a sample narration." for preview (T-03-19-02 accepted).
- **`VoiceCatalogDialog.tsx`** -- Modal dialog with `data-testid="voice-catalog"`. Two modes: curated (720x560) and expanded (960x720). Locale filter chips via radio group. Empty states: "Chua ket noi provider TTS" (no API key) with Settings link, "Khong co giong nao khop" (no matches). Loads voices via `tts_voice_list` on open.
- **`VoicePresetCard.tsx`** -- Card with voice name, locale, premium badge, Featured badge (accent, max 2 per UI-SPEC rule #6). "Nghe thu" button with `aria-pressed` during playback and `aria-label` per accessibility spec. Conic-gradient ring animation (2.4s linear) during preview.
- **7 Vitest tests:** curated mode default, expand toggle, locale filter, preview playback, empty filter, no-API-key state, Featured badge cap.

**Task 2 -- TtsScriptEditor + TtsClipInspector.**

- **`TtsScriptEditor.tsx`** -- Per-step script editor with controlled textarea. Empty state: "Chua co loi thoai cho buoc nay" + CTA "Sinh loi thoai". Editor state: char count (`{N} / 800`) with warning color at 700+, cost estimate in JetBrains Mono 12px, "Sinh loi thoai" / "Tao lai audio" accent buttons. Dirty tracking: editing after generation shows "Da sua, chua tao lai audio" warning chip.
- **`TtsClipInspector.tsx`** -- Inspector panel showing step ID, status badge (5 states: generated/out-of-sync/regenerating/failed/selected), voice preset name, duration, cost, cache-hit indicator, "Tao lai audio" button.
- **5 Vitest tests:** empty state + CTA, generate invoke, char count + cost, stale warning chip, regenerate button.

## Decisions Made

1. **MockAudio class pattern** -- `vi.stubGlobal("Audio", MockAudio)` with a class definition ensures proper constructor semantics in happy-dom, avoiding the "did not use function/class" warning.
2. **Unicode escapes for Vietnamese** -- Consistent with Plans 17/18 pattern; ensures happy-dom renders correctly.
3. **Featured badge cap via useMemo counter** -- Simpler than store-level validation; UI-only concern that doesn't affect data model.
4. **ElevenLabs cost rate in editor** -- $0.30/1K chars hardcoded, matching AI-SPEC section 4 and Plan 11 cost constants.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(03-19): VoiceCatalogDialog + VoicePresetCard + voiceoverStore + useTts hook` | `25dfe26` |
| 2 | `feat(03-19): TtsScriptEditor + TtsClipInspector with regenerate` | `48e9d50` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed MockAudio class pattern for test compatibility.**
- **Found during:** Task 1 GREEN phase (test 4 failing).
- **Issue:** `vi.fn().mockImplementation()` for global Audio constructor did not properly behave as a constructor in happy-dom, causing `play()` mock to not be called.
- **Fix:** Replaced with a proper `class MockAudio` definition using `vi.stubGlobal`.
- **Files modified:** `VoiceCatalogDialog.test.tsx`.
- **Commit:** `25dfe26`.

**2. [Rule 1 - Bug] Removed unused imports (TS6133).**
- **Found during:** Task 2 typecheck.
- **Issue:** `useState`, `useEffect` unused in TtsScriptEditor; `projectId` unused in TtsClipInspector; `userEvent` unused in VoiceCatalogDialog test; `rerender` unused in TtsScriptEditor test.
- **Fix:** Removed unused imports, prefixed unused destructured params with underscore.
- **Files modified:** `TtsScriptEditor.tsx`, `TtsClipInspector.tsx`, `VoiceCatalogDialog.test.tsx`, `TtsScriptEditor.test.tsx`.
- **Commit:** `48e9d50`.

---

**Total deviations:** 2 auto-fixed (both Rule 1 -- bug fixes). No scope creep.

## Verification

```bash
npx vitest run src/features/voiceover/  # 12/12 passed (7 + 5)
```

**Task 1 acceptance criteria:**
- All 7 tests green - PASS
- `grep -c "Xem t" VoiceCatalogDialog.tsx` -> 1 (>= 1) - PASS
- `grep -c "Nghe th" VoicePresetCard.tsx` -> 3 (>= 1) - PASS
- `grep -c "provider TTS" VoiceCatalogDialog.tsx` -> 2 (>= 1) - PASS

**Task 2 acceptance criteria:**
- All 5 tests green - PASS
- `grep -c "Sinh l" TtsScriptEditor.tsx` -> 5 (>= 1) - PASS
- `grep "Tao lai audio" TtsScriptEditor.tsx TtsClipInspector.tsx` -> 2 matches - PASS

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-19-01 (Tampering / Malformed MP3) | mitigated | `audio.onerror` handler catches playback failures; error logged to console, playingId reset to null; no crash propagation |
| T-03-19-02 (Info Disclosure / Preview sample text) | accepted | Sample text is hard-coded English ("This is a sample narration.") -- no user PII crosses to provider for preview |

## Known Stubs

None. All components are fully implemented with real Tauri IPC wiring via `invoke`. Voice list loads from backend, preview generates real audio, script editor generates/regenerates via backend commands.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes. All communication is IPC-only (webview-to-host via existing Plan 11 Tauri commands).

## Issues Encountered

None beyond the auto-fixed deviations. TDD cycle ran clean after MockAudio pattern fix.

## Authentication Gates

None -- all tests use mocked Tauri IPC. Real API key resolution happens in the Rust backend (Plan 11's `read_api_key`).

## User Setup Required

None at build/test time. At runtime, users must have stored an API key for their chosen TTS provider via the key management UI (Plan 03-03).

## Next Plan Readiness

- **Phase 2 sound track:** TTS clips in `clipByStepId` store are ready for timeline placement with `filePath` and `durationMs`.
- **Eval harness (Plan 21):** Can render voiceover components with mocked store state to verify UI behavior end-to-end.
- **Editor integration:** VoiceCatalogDialog can be opened from any editor toolbar; TtsScriptEditor embeds in the step inspector panel.

## Handoff Notes

- `voiceoverStore` uses `Set<string>` for `generating` -- not serializable to JSON. If persistence is ever needed, convert to `string[]`.
- `useTts.preview()` plays audio immediately via `new Audio(file_path).play()`. The file_path is an absolute local path from `tts_generate` result. In Tauri, `file://` protocol access may require `asset:` protocol conversion for webview security policies.
- The Featured badge cap (max 2) is enforced in the `VoiceCatalogDialog` useMemo, not in the store. If voice presets are rendered elsewhere, the cap must be re-enforced.
- Cost estimate in TtsScriptEditor uses `$0.30/1K` (ElevenLabs rate). When OpenAI TTS is selected, the rate should adjust -- currently hardcoded. This is a known simplification matching Plan 11's approach.

## Self-Check: PASSED

File existence:
- `apps/desktop/src/features/voiceover/voiceoverStore.ts` -> FOUND
- `apps/desktop/src/features/voiceover/useTts.ts` -> FOUND
- `apps/desktop/src/features/voiceover/VoiceCatalogDialog.tsx` -> FOUND
- `apps/desktop/src/features/voiceover/VoicePresetCard.tsx` -> FOUND
- `apps/desktop/src/features/voiceover/TtsScriptEditor.tsx` -> FOUND
- `apps/desktop/src/features/voiceover/TtsClipInspector.tsx` -> FOUND
- `apps/desktop/src/features/voiceover/VoiceCatalogDialog.test.tsx` -> FOUND
- `apps/desktop/src/features/voiceover/TtsScriptEditor.test.tsx` -> FOUND

Commits:
- `25dfe26` (feat 03-19 catalog + store) -> FOUND
- `48e9d50` (feat 03-19 script editor + inspector) -> FOUND

Verification:
- `npx vitest run src/features/voiceover/` -> 12/12 passed

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*

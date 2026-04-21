# Phase 14: Port Claude Design into apps/desktop — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `14-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-04-21
**Phase:** 14-port-claude-design-into-apps-desktop
**Areas discussed:** Token reconciliation, Screen port scope, Theme mode + platform chrome, Primitives strategy, Behavior preservation, Rollout strategy, Font stack

---

## Gray Area Selection

| Option | Description | Selected |
|---|---|---|
| Token reconciliation | sc-* vs existing Cursor-warm tokens | ✓ |
| Screen port scope | Which of 7 screens port to which existing route | ✓ |
| Theme mode + platform chrome | Dark/light + custom titlebar | ✓ |
| Primitives strategy | .sc-* CSS vs typed React wrappers vs replace shadcn | ✓ |

All four selected.

---

## Token reconciliation

| Option | Description | Selected |
|---|---|---|
| Replace existing with sc-* | Single design system; retire Cursor-warm tokens | ✓ |
| Coexist — namespace sc-* alongside | Both systems ship; lowest churn, two languages visible | |
| Merge into unified token set | Pick winners per token, collapse to one namespace | |

**User's choice:** Replace existing with sc-* (Recommended).
**Notes:** Biggest consistency win; every existing feature's styling migrates to sc-*.

---

## Theme mode

| Option | Description | Selected |
|---|---|---|
| Dark-only for v1 | Ship dark, defer light QA | |
| Dark + light both supported, dark default | User-facing theme toggle in Settings; full WCAG QA both themes | ✓ |
| Light-first | Invert to light default; Cursor-warm feel preserved | |

**User's choice:** Dark + light both supported, dark default.
**Notes:** Ships the full Claude Design promise; both themes must pass WCAG 2.1 AA.

---

## Platform chrome

| Option | Description | Selected |
|---|---|---|
| Adopt the custom chrome | decorations: false, port chrome.jsx, per-OS chrome | ✓ |
| Keep Tauri default chrome | Skip chrome.jsx, zero window-plumbing | |
| Adopt chrome on macOS only | Split design across platforms | |

**User's choice:** Adopt the custom chrome (Recommended).
**Notes:** Biggest visual payoff; requires Tauri window-plugin wiring + per-OS QA.

---

## Primitives strategy

| Option | Description | Selected |
|---|---|---|
| Wrap sc-* as React primitives in packages/ui | Typed ScButton/ScInput/… ; no shadcn churn | ✓ |
| Use .sc-* classes directly | Fastest, no type safety | |
| Replace shadcn+Base UI in ported screens | Biggest vision; conflicts with committed stack | |

**User's choice:** Wrap sc-* as React primitives in packages/ui (Recommended).
**Notes:** Preserves committed stack (shadcn + Base UI stays for un-ported features).

---

## Screen port scope (routes)

| Option | Description | Selected |
|---|---|---|
| Dashboard | Replace routes/dashboard.tsx | ✓ |
| Editor | Replace routes/editor.tsx | ✓ |
| Post-production | Replace routes/post-production.tsx | ✓ |
| Settings | Replace routes/settings.tsx | ✓ |

**User's choice:** All four routes.

---

## Screen port scope (overlays + showcase)

| Option | Description | Selected |
|---|---|---|
| Port chrome.jsx | Titlebar + side nav shell — required by chrome decision | ✓ |
| Port CommandPalette + ToastStack | Cmd/Ctrl-K + toast system | ✓ |
| Port RecordingIndicator + TweaksPanel | Floating badge + live theme tweaker | ✓ |
| Port tokens.jsx + components.jsx as /_design-system | Hidden dev-only showcase route | ✓ |

**User's choice:** All overlays + showcase.

---

## Export

| Option | Description | Selected |
|---|---|---|
| Port export.jsx into features/export/ | Visual restyle only; preserve Phase 13 wiring | ✓ |
| Defer export port | Keep existing export-modal.tsx this phase | |
| Skip export entirely | Accept visual drift permanently | |

**User's choice:** Port export.jsx into features/export/ (Recommended).

---

## TweaksPanel

| Option | Description | Selected |
|---|---|---|
| Dev-only behind a debug flag | Invisible to end users | ✓ |
| Expose in Settings as Appearance controls | Full user-facing theme/accent/density/radius | |
| Drop entirely | Not part of v1 | |

**User's choice:** Dev-only behind a debug flag (Recommended).
**Notes:** Settings → Appearance exposes a subset (theme + accent hue only); density/radius stay dev-only.

---

## Behavior / wiring preservation

| Option | Description | Selected |
|---|---|---|
| Visual-only — preserve all wiring | Pure re-skin; deviations halt the wave | ✓ |
| Visual-first, allow minor behavior cleanup | Targeted fixes, deviation log | |
| Port mock-first; rewire incrementally | Non-functional between waves | |

**User's choice:** Visual-only — preserve all wiring (Recommended).

---

## Rollout

| Option | Description | Selected |
|---|---|---|
| Big-bang per wave | Flip one route at a time; delete old; no flag | ✓ |
| Feature flag behind ?cd=1 or env | Old + new side by side; cleanup wave removes flag | |
| Progressive — shell + tokens first, screens in later phases | Lowest per-phase risk, delays payoff | |

**User's choice:** Big-bang per wave (Recommended).

---

## Font stack

| Option | Description | Selected |
|---|---|---|
| Inter + JetBrains Mono only | Match Claude Design exactly; drop Lora + Outfit | ✓ |
| Inter + JetBrains Mono + keep Lora/Outfit | Preserve existing identity; mix typographic systems | |
| Claude's Discretion | Planner/researcher picks based on screens | |

**User's choice:** Inter + JetBrains Mono only (Recommended).

---

## Claude's Discretion

- Component naming inside `packages/ui/src/claude-design/` (must not collide with shadcn).
- Toast system mechanics (replace `sonner` vs skin `sonner`) — planner picks.
- Dev-only TweaksPanel keyboard shortcut (no collisions with existing bindings).
- Motion token / transition mapping to `motion/react`.
- WCAG AA verification methodology.
- Visual treatment of not-explicitly-mocked routes (`recorder.tsx`, `index.tsx`).

## Deferred Ideas

- Light-mode visual polish pass (a follow-up phase).
- Commissioning Claude Design mocks for `recorder.tsx` / `index.tsx` / un-mocked modals.
- Controls shown in mocks but not yet implemented in the app.
- End-user density + radius controls in Settings.
- Full Storybook setup (this phase ships a lightweight `/_design-system` showcase only).
- Transitional tokens.css stub — final wave deletes it.
- Replacing shadcn/Base UI globally.

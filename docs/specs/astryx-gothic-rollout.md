# Astryx Gothic rollout specification

## Objective

Replace StoryCapture's generic desktop and web UI with Astryx 0.1.6 and a
StoryCapture-owned Gothic theme. The production release is a single cutover:
the rollout branch must not ship while legacy and Astryx primitives coexist.

## Product contract

- The application theme is dark-only. There is no user-selectable light mode.
- Generic controls import directly from `@astryxdesign/core/<Component>`.
- `@storycapture/ui` owns only the built theme, provider, fonts, and product
  tokens. It must not re-export generic Astryx controls.
- Tailwind is restricted to structural layout. Visual state comes from Astryx
  components or theme tokens.
- Electron window controls, CodeMirror, WaveSurfer, DnD, and media workspace
  behavior remain product-specific.
- Recorded media, composition pixels, and export rendering are outside the
  application theme. The packaged Geist export font remains unchanged.

## Component contract

| Legacy family | Astryx target |
| --- | --- |
| Buttons | Button / IconButton |
| Text and numeric fields | TextInput / TextArea / NumberInput / Field |
| Select and search | Selector / Typeahead / MultiSelector |
| Dialogs and menus | Dialog / AlertDialog / DropdownMenu / ContextMenu / Popover |
| Choice controls | Switch / Slider / SegmentedControl / ToggleButtonGroup / RadioList |
| Status and content | Toast / Banner / Badge / Card / ListItem / EmptyState |
| Navigation and workspace | AppShell / TopNav / SideNav / Layout / LayoutPanel |

Domain compounds are allowed only when they add StoryCapture behavior. A
wrapper whose only purpose is to rename Astryx props is not allowed.

### Native control boundary

Generic forms, actions, menus, dialogs, and navigation use Astryx. Raw HTML
controls are permitted only where replacing the DOM element would change a
StoryCapture interaction contract: authored-preview editing, native color or
file input, a validated numeric field that must preserve an invalid draft,
timeline/drag/selection hit targets, and Electron native chrome. These controls
still consume Gothic semantic or `--story-*` tokens.

`scripts/check-astryx-rollout.mjs` records every approved production TSX file
and its exact raw-control count. A raw control in a new file, or an increased
count in an approved file, fails the rollout gate. The allowlist must shrink as
Astryx gains an equivalent that preserves the behavior contract.

## Browser and accessibility contract

- Desktop targets its packaged Electron Chromium runtime.
- Web supports Astryx Tier 2: Chrome/Edge 114+, Safari 17+, Firefox 125+.
- Web loads `@oddbird/css-anchor-positioning` only when CSS anchor positioning
  is unavailable.
- All interactive controls must be keyboard reachable, expose an accessible
  name, preserve focus across layers, honor reduced motion, and pass serious
  and critical axe checks.

## Completion gates

- No `Sc*`, `claude-design`, `@/components/ui`, Base UI, cmdk, Sonner, CVA,
  `--sc-*`, light-theme selector, or `components.json` remains.
- No native generic control exists outside the documented product boundary.
- Theme generated output matches its source.
- UI, desktop, and web tests and typechecks pass.
- Media, cursor, scroll, recording helper, and packaged export E2E gates pass.
- Desktop and web visual baselines cover normal, loading, empty, error, and
  layered states at the viewports recorded in the rollout plan.

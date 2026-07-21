# StoryCapture Desktop UX V2.1 Visual Contract

## Objective

Reorganize the desktop application around one project pipeline:

`Author → Preview → Record → Edit → Export`

This contract refines the current cinematic creator-studio direction. It does not replace Design System V2 and does not change routes, IPC, DSL, recording, export, or persistence contracts.

## Approval gate

Runtime migration must not begin until the V2.1 gallery and canonical screen references are approved. The catalog-only prototype is available with:

```text
http://127.0.0.1:4176/?contract=desktop-v2.1&theme=dark&density=desktop&screen=gallery
```

Use `pnpm --dir packages/ui catalog` to run the reference catalog.

## Visual direction

- Dark-first graphite studio with a warm amber primary accent.
- Geist for interface text and Geist Mono for timing, dimensions, progress, and technical metadata.
- Three surface levels: application chrome, workspace, and elevated or selected panel.
- Borders communicate real boundaries; spacing and typography communicate grouping.
- Amber is reserved for primary action, selection, and progress.
- Red is reserved for recording, destructive action, and blocking failure.
- Green is reserved for verified, connected, and successful states.
- Non-disabled body text targets 4.5:1 contrast. Focus and control boundaries target 3:1.
- Body text is at least 12px in runtime screens. Smaller text is limited to concise technical metadata.
- Motion lasts 120-180ms and only communicates navigation continuity, state changes, recording, or feedback.

## Project pipeline

### Global shell

- Global navigation contains Projects, Search and commands, and Settings.
- Project-specific tools are removed from global navigation.
- Project screens use a shared stage header with project identity, stage status, and one contextual primary action.

### Hybrid gates

| Stage | Available when | Blocking behavior |
| --- | --- | --- |
| Author | Project opens | Never blocked |
| Preview | Project opens | Never blocked |
| Record | Story parses and StoryBuilder is valid | Focus the blocking issue list |
| Edit | A valid recording exists | Link back to Record |
| Export | Video track exists and preflight has no critical issue | Link to the blocking review item |

### Canonical state model

- `current`: the visible project stage.
- `available`: the stage can be entered.
- `complete`: the stage has valid output for the current project state.
- `blocked`: a hard prerequisite is missing.
- `needs_attention`: the stage has recoverable warnings or failures.

## Screen contracts

### Dashboard

- Populated: responsive project grid plus Continue working rail.
- Empty: one primary create action and no duplicate create tile.
- Loading: project-card skeletons preserve final grid geometry.
- Error: direct recovery message; project folders are described as remaining on disk.
- Cards show workflow type, session count, last opened, and Draft or Recorded only.

### Author and Preview

- Author keeps the active scene and actions visible; Motion, Cursor, Canvas, Audio, and Polish are disclosed under Advanced.
- Invalid Author state replaces Record with Fix issues.
- Preview uses the same route and expands live preview plus simulator timeline.
- Preview states: idle, running, failed, and complete.
- Author/Preview split, collapse, and focus preferences are renderer-only UI state.

### Recorder

- Setup separates the capture stage from a readiness checklist.
- Active recording locks project navigation and capture configuration.
- Primary actions by state: Start recording, Stop, Resume, verifying progress, Review recording, or Retry recording.
- Completed recordings offer Review recording, Record another take, and Back to Author.
- The legacy `?polish=1` behavior remains supported but is not emitted by the new UI.

### Edit and Export

- Guided Review is the default post-production mode.
- Fine Tune reveals Preview, Inspector, and Timeline with accessible splitters.
- Export has one entry point in the project header.
- Export remains disabled with a visible reason when preflight is blocked.

### Settings

- Existing settings behaviors remain intact.
- Navigation groups: Workspace, Capture, Output, Connections, and System.
- Reset is contextual to the current section.

### Onboarding

- Four steps: Goal, Target, Permissions, and Project setup.
- Goal maps to the existing workflow catalog.
- Target URL prefills `target_url` in the selected workflow.
- Permission rows report live probe results rather than static promises.
- The final step opens project creation with a renderer-only draft.

## References

Generated references live in `packages/ui/visual-tests/__screenshots__`:

- Four gallery baselines: dark/light at 1440×1024 and 1280×800.
- Eight dark canonical screens at 1440×1024.
- Nine dark risk-state screens at 1440×1024.

The current implementation screenshots and audit that motivated this contract live in `docs/audit/theme-ui-ux-2026-07-21`.

## Validation

```bash
pnpm --dir packages/ui typecheck
pnpm --dir packages/ui test:visual
```

Approval means the gallery, screen hierarchy, action model, surface ladder, and state treatments are accepted as the source of truth for runtime migration.

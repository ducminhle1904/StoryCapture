quick_id: 260502-gvw
mode: quick
title: Guided video workflows for Create Story

## Goal

Add a desktop-local guided creation flow beside Freestyle. Guided workflows
seed a parseable `.story` file and persist roadmap metadata under
`.storycapture/workflow.json`.

## Scope

- Extend project creation with optional starter story and workflow state.
- Add thin IPC commands for workflow metadata read/write.
- Replace the dashboard new-project dialog with a guided creation hub.
- Show the workflow roadmap in the editor UI mode.
- Keep web Template schema/API unchanged.

## Verification

- Rust storage tests for default and guided project creation.
- Regenerate Tauri Specta IPC bindings.
- Desktop Vitest coverage for the creation hub and roadmap panel.
- Typecheck relevant desktop TypeScript.

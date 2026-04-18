/**
 * Plan 07-05 — Author-time selector validator overlay.
 *
 * Reads the parsed story AST from `useEditorStore().lastParse` and, for
 * every step that carries a `target + url-context`, calls
 * `author_snapshot_validate` against the cached DOM snapshot. Results
 * are written into a Zustand store keyed by step line number so the
 * CodeMirror gutter markers and the Preview panel bbox overlay can
 * read from the same source.
 *
 * Debounce: 250 ms per step-key change. Validation NEVER blocks typing
 * because the IPC call is fire-and-forget and results only update the
 * store when they land.
 *
 * The overlay is PURELY READ-ONLY against `.story.targets.json` — it
 * never mutates until the user clicks "Promote to fallback" (a future
 * affordance that lands in the SelectorFallbackPopover surface).
 *
 * This component renders nothing visible on its own; it's a
 * side-effect sentinel mounted once in the editor tree. Visual chip
 * rendering lives in the gutter marker extension and in the Preview
 * panel bbox overlay that read from `useSelectorValidation`.
 */

import { useEffect, useRef } from "react";
import { create } from "zustand";

import { useEditorStore } from "@/state/editor";
import {
  authorSnapshotValidate,
  type AuthorValidation,
} from "@/ipc/author_snapshot";
import type { SelectorOrText, Story } from "@/ipc/parse";

export interface ValidatorEntry {
  /** 1-indexed line number from the parse span. */
  line: number;
  /** The URL this step is validated against (resolved from `Navigate` context). */
  url: string;
  /** Last validation outcome — `null` while the debounced call is in flight. */
  status: AuthorValidation | null;
  /** Stringified target for hit-detection / memoisation. */
  targetKey: string;
}

interface ValidatorStore {
  entries: Map<number, ValidatorEntry>;
  setEntry: (line: number, entry: ValidatorEntry) => void;
  clear: () => void;
}

export const useSelectorValidation = create<ValidatorStore>((set) => ({
  entries: new Map(),
  setEntry: (line, entry) =>
    set((s) => {
      const next = new Map(s.entries);
      next.set(line, entry);
      return { entries: next };
    }),
  clear: () => set({ entries: new Map() }),
}));

/**
 * Extract the (line, url, target) triples from a parsed story. Each
 * Navigate command carries its url forward as the "active URL" for all
 * subsequent steps in the same scene until another Navigate resets it.
 * Meta-level `app` URL is the fallback for scenes that begin without
 * an explicit Navigate.
 */
export function collectValidatableSteps(story: Story): Array<{
  line: number;
  url: string;
  target: SelectorOrText;
}> {
  const out: Array<{ line: number; url: string; target: SelectorOrText }> = [];
  const fallbackUrl = story.meta.app ?? "";
  for (const scene of story.scenes) {
    let activeUrl = fallbackUrl;
    for (const cmd of scene.commands) {
      switch (cmd.verb) {
        case "navigate":
          activeUrl = cmd.url;
          break;
        case "click":
        case "hover":
        case "assert":
        case "wait-for":
          if (activeUrl) {
            out.push({
              line: cmd.span.line,
              url: activeUrl,
              target: cmd.target,
            });
          }
          break;
        case "type":
        case "upload":
        case "select":
          if (activeUrl) {
            out.push({
              line: cmd.span.line,
              url: activeUrl,
              target: cmd.target,
            });
          }
          break;
        // drag has `from`/`to`; validate only the `from` so we don't
        // conflate two chips on one line. Plan's Phase-7 synergy note
        // says drag-to is deliberately NOT self-healed either.
        case "drag":
          if (activeUrl) {
            out.push({
              line: cmd.span.line,
              url: activeUrl,
              target: cmd.from,
            });
          }
          break;
        default:
          break;
      }
    }
  }
  return out;
}

interface SelectorValidatorOverlayProps {
  /** Absolute path to the open project's root directory. */
  projectDir: string | null;
  /** Debounce in ms before firing a validate IPC after the target changes. Default 250. */
  debounceMs?: number;
}

/**
 * Pure side-effect component: subscribes to the parsed story, debounces
 * per-step validate calls, writes results into `useSelectorValidation`.
 */
export function SelectorValidatorOverlay({
  projectDir,
  debounceMs = 250,
}: SelectorValidatorOverlayProps) {
  const lastParse = useEditorStore((s) => s.lastParse);
  const setEntry = useSelectorValidation((s) => s.setEntry);
  const clear = useSelectorValidation((s) => s.clear);
  const pending = useRef<Map<number, number>>(new Map());
  const lastKeys = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    if (!projectDir || !lastParse?.ast) {
      clear();
      return;
    }
    const steps = collectValidatableSteps(lastParse.ast);
    const currentLines = new Set<number>();

    for (const step of steps) {
      currentLines.add(step.line);
      const targetKey = `${step.url}|${JSON.stringify(step.target)}`;
      if (lastKeys.current.get(step.line) === targetKey) {
        // No change for this step — skip re-validation.
        continue;
      }
      lastKeys.current.set(step.line, targetKey);

      // Mark as pending so the UI can show a spinner rather than flashing
      // the stale status while the debounced call resolves.
      setEntry(step.line, {
        line: step.line,
        url: step.url,
        targetKey,
        status: null,
      });

      // Debounce.
      const prev = pending.current.get(step.line);
      if (prev !== undefined) window.clearTimeout(prev);
      const handle = window.setTimeout(() => {
        authorSnapshotValidate(projectDir, step.url, step.target)
          .then((status) => {
            setEntry(step.line, {
              line: step.line,
              url: step.url,
              targetKey,
              status,
            });
          })
          .catch((err) => {
            // On IPC error, surface as `none` with reason in console —
            // typing still works; the user sees a RED chip.
            // eslint-disable-next-line no-console
            console.warn(
              `[07-05] validate failed for line ${step.line}: ${String(err)}`,
            );
            setEntry(step.line, {
              line: step.line,
              url: step.url,
              targetKey,
              status: { status: "none" },
            });
          });
      }, debounceMs);
      pending.current.set(step.line, handle);
    }

    // Drop stale lines that no longer have a step (e.g. user deleted a line).
    for (const line of Array.from(lastKeys.current.keys())) {
      if (!currentLines.has(line)) {
        lastKeys.current.delete(line);
        const handle = pending.current.get(line);
        if (handle !== undefined) {
          window.clearTimeout(handle);
          pending.current.delete(line);
        }
      }
    }
  }, [projectDir, lastParse, setEntry, clear, debounceMs]);

  // Cleanup pending timers on unmount.
  useEffect(() => {
    return () => {
      for (const handle of pending.current.values()) {
        window.clearTimeout(handle);
      }
      pending.current.clear();
    };
  }, []);

  return null;
}

/**
 * UI helper — map a `AuthorValidation` onto the chip-state letter used
 * throughout this feature. `G`=green, `Y`=yellow, `R`=red, `_`=grey
 * (no snapshot), `?`=loading.
 */
export function chipStateChar(status: AuthorValidation | null): string {
  if (status === null) return "?";
  switch (status.status) {
    case "unique":
      return "G";
    case "fuzzy":
      return "Y";
    case "none":
      return "R";
    case "no_snapshot":
      return "_";
  }
}

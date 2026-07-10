/**
 * Author-time selector validator overlay.
 *
 * For every step in the parsed story that carries a `target + url-context`,
 * calls `author_snapshot_validate` against the cached DOM snapshot and
 * writes the result into a Zustand store keyed by line number so the
 * CodeMirror gutter and the Preview panel bbox overlay read from the
 * same source.
 *
 * Debounced 250ms per step-key change. Validation never blocks typing —
 * IPC is fire-and-forget; results only update the store when they land.
 *
 * The overlay is purely read-only against `.story.targets.json`; it
 * mutates nothing until the user clicks "Promote to fallback".
 *
 * Renders nothing visible — side-effect sentinel mounted once in the
 * editor tree.
 */

import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { type AuthorValidation, authorSnapshotValidate } from "@/ipc/author_snapshot";
import type { SelectorOrText, Story } from "@/ipc/parse";
import { useDebouncedCallback } from "@/lib/useDebouncedCallback";
import { useEditorStore } from "@/state/editor";

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
        // conflate two chips on one line. drag-to is deliberately not
        // self-healed either.
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
  const lastKeys = useRef<Map<number, string>>(new Map());
  const steps = useMemo(
    () => (lastParse?.ast ? collectValidatableSteps(lastParse.ast) : null),
    [lastParse],
  );

  const validate = useDebouncedCallback(
    (line: number, targetKey: string, url: string, target: SelectorOrText, dir: string) => {
      authorSnapshotValidate(dir, url, target)
        .then((status) => {
          setEntry(line, { line, url, targetKey, status });
        })
        .catch(() => {
          setEntry(line, {
            line,
            url,
            targetKey,
            status: { status: "none" },
          });
        });
    },
    debounceMs,
  );

  useEffect(() => {
    if (!projectDir || !steps) {
      clear();
      return;
    }
    const currentLines = new Set<number>();

    for (const step of steps) {
      currentLines.add(step.line);
      const targetKey = `${step.url}|${JSON.stringify(step.target)}`;
      if (lastKeys.current.get(step.line) === targetKey) {
        continue;
      }
      lastKeys.current.set(step.line, targetKey);

      // Mark pending so the UI shows a spinner rather than the stale status.
      setEntry(step.line, {
        line: step.line,
        url: step.url,
        targetKey,
        status: null,
      });
      validate.runKeyed(step.line, step.line, targetKey, step.url, step.target, projectDir);
    }

    // Drop stale lines that no longer have a step.
    for (const line of Array.from(lastKeys.current.keys())) {
      if (!currentLines.has(line)) {
        lastKeys.current.delete(line);
        validate.cancel(line);
      }
    }
  }, [projectDir, steps, setEntry, clear, validate]);

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

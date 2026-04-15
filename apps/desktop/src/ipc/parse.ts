/**
 * `parse_story` IPC wrapper (Plan 01-09 Task 0 host side, Task 2 renderer).
 * The Rust command returns a DTO tree that mirrors `story-parser`'s AST.
 */

import { invoke } from "@tauri-apps/api/core";

export type Severity = "error" | "warning" | "info";

export interface Span {
  start: number;
  end: number;
  line: number;
  col: number;
}

export interface Diagnostic {
  severity: Severity;
  message: string;
  span: Span;
  suggestion: string | null;
}

export type SelectorOrText =
  | { kind: "text"; value: string }
  | { kind: "selector"; value: string }
  | { kind: "test_id"; value: string }
  | { kind: "aria"; value: string };

export type ScrollDir = "up" | "down" | "left" | "right";

export type Command =
  | { verb: "navigate"; url: string; span: Span }
  | { verb: "click"; target: SelectorOrText; span: Span }
  | { verb: "type"; target: SelectorOrText; text: string; span: Span }
  | { verb: "scroll"; direction: ScrollDir; amount: number | null; span: Span }
  | { verb: "hover"; target: SelectorOrText; span: Span }
  | { verb: "drag"; from: SelectorOrText; to: SelectorOrText; span: Span }
  | { verb: "select"; target: SelectorOrText; value: string; span: Span }
  | { verb: "upload"; target: SelectorOrText; path: string; span: Span }
  | { verb: "wait"; duration_ms: number; span: Span }
  | {
      verb: "wait-for";
      target: SelectorOrText;
      timeout_ms: number | null;
      span: Span;
    }
  | { verb: "assert"; target: SelectorOrText; span: Span }
  | { verb: "screenshot"; name: string; span: Span }
  | { verb: "pause"; span: Span };

export interface Scene {
  name: string;
  commands: Command[];
  span: Span;
}

export interface Meta {
  app: string | null;
  viewport: { width: number; height: number } | null;
  theme: "light" | "dark" | "auto" | null;
  speed: number | null;
  span: Span;
}

export interface Story {
  name: string | null;
  meta: Meta;
  scenes: Scene[];
  span: Span;
}

export interface ParseResult {
  ast: Story | null;
  diagnostics: Diagnostic[];
}

export function parseStory(source: string): Promise<ParseResult> {
  return invoke<ParseResult>("parse_story", { source });
}

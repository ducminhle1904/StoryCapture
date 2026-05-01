/**
 * `parse_story` IPC wrapper. The Rust command returns a DTO tree that
 * mirrors `story-parser`'s AST.
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
  | { kind: "aria"; value: string }
  | { kind: "role"; value: { role: string; name: string } }
  | { kind: "label"; value: string }
  | { kind: "text_exact"; value: string };

export type ScrollDir = "up" | "down" | "left" | "right";

export type Command =
  | { verb: "navigate"; url: string; span: Span; step_id?: string | null }
  | { verb: "click"; target: SelectorOrText; span: Span; step_id?: string | null }
  | { verb: "type"; target: SelectorOrText; text: string; span: Span; step_id?: string | null }
  | {
      verb: "scroll";
      direction: ScrollDir;
      amount: number | null;
      span: Span;
      step_id?: string | null;
    }
  | { verb: "hover"; target: SelectorOrText; span: Span; step_id?: string | null }
  | { verb: "drag"; from: SelectorOrText; to: SelectorOrText; span: Span; step_id?: string | null }
  | { verb: "select"; target: SelectorOrText; value: string; span: Span; step_id?: string | null }
  | { verb: "upload"; target: SelectorOrText; path: string; span: Span; step_id?: string | null }
  | { verb: "wait"; duration_ms: number; span: Span; step_id?: string | null }
  | {
      verb: "wait-for";
      target: SelectorOrText;
      timeout_ms: number | null;
      span: Span;
      step_id?: string | null;
    }
  | { verb: "assert"; target: SelectorOrText; span: Span; step_id?: string | null }
  | { verb: "screenshot"; name: string; span: Span; step_id?: string | null }
  | { verb: "pause"; span: Span; step_id?: string | null };

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

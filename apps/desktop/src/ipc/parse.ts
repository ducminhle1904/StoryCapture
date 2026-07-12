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
export type ScrollUnit = "px" | "vh";

export type Command =
  | { verb: "navigate"; url: string; span: Span; step_id?: string | null }
  | {
      verb: "click";
      target: SelectorOrText;
      target_nth?: number;
      span: Span;
      step_id?: string | null;
    }
  | {
      verb: "type";
      target: SelectorOrText;
      target_nth?: number;
      text: string;
      span: Span;
      step_id?: string | null;
    }
  | {
      verb: "scroll";
      target?: SelectorOrText;
      target_nth?: number;
      direction: ScrollDir;
      amount: number;
      unit: ScrollUnit;
      span: Span;
      step_id?: string | null;
    }
  | {
      verb: "hover";
      target: SelectorOrText;
      target_nth?: number;
      span: Span;
      step_id?: string | null;
    }
  | {
      verb: "drag";
      from: SelectorOrText;
      from_nth?: number;
      to: SelectorOrText;
      to_nth?: number;
      span: Span;
      step_id?: string | null;
    }
  | {
      verb: "select";
      target: SelectorOrText;
      target_nth?: number;
      value: string;
      span: Span;
      step_id?: string | null;
    }
  | {
      verb: "upload";
      target: SelectorOrText;
      target_nth?: number;
      path: string;
      span: Span;
      step_id?: string | null;
    }
  | { verb: "wait"; duration_ms: number; span: Span; step_id?: string | null }
  | {
      verb: "wait-for" | "wait-for-visible";
      target: SelectorOrText;
      target_nth?: number;
      timeout_ms: number | null;
      span: Span;
      step_id?: string | null;
    }
  | {
      verb: "assert" | "assert-visible";
      target: SelectorOrText;
      target_nth?: number;
      span: Span;
      step_id?: string | null;
    }
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

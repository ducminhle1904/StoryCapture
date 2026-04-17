/**
 * Timeline panel — multi-track timeline inspired by DaVinci Resolve / Descript.
 *
 * Tracks: video (scene clips), voiceover, effects.
 * Time ruler with tick marks. Proportional clip widths.
 * Duration heuristic (Phase 1): `wait <ms>` -> X ms, everything else 1500 ms.
 */

import { useMemo } from "react";
import {
  Clock,
  Mic2,
  Sparkles,
  Film,
} from "lucide-react";

import { useEditorStore } from "@/state/editor";
import type { Command, Scene } from "@/ipc/parse";

const DEFAULT_STEP_MS = 1500;

function estimateStepDuration(c: Command): number {
  if (c.verb === "wait") return Math.max(100, Number(c.duration_ms) || 0);
  return DEFAULT_STEP_MS;
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/** Color map for verb categories — muted, warm tones */
function verbColor(verb: string): string {
  switch (verb) {
    case "navigate":
      return "var(--color-timeline-read)";
    case "click":
    case "hover":
    case "drag":
    case "select":
      return "var(--color-accent-primary)";
    case "type":
    case "upload":
      return "var(--color-timeline-edit)";
    case "wait":
    case "wait-for":
    case "pause":
      return "var(--color-timeline-thinking)";
    case "assert":
    case "screenshot":
      return "var(--color-timeline-grep)";
    default:
      return "var(--color-fg-muted)";
  }
}

interface SceneClip {
  scene: Scene;
  index: number;
  startMs: number;
  durationMs: number;
  commands: Array<{
    cmd: Command;
    startMs: number;
    durationMs: number;
    index: number;
  }>;
}

function buildClips(scenes: Scene[]): { clips: SceneClip[]; totalMs: number } {
  let cursor = 0;
  const clips: SceneClip[] = scenes.map((scene, idx) => {
    let cmdCursor = cursor;
    const commands = scene.commands.map((cmd, cidx) => {
      const dur = estimateStepDuration(cmd);
      const entry = { cmd, startMs: cmdCursor, durationMs: dur, index: cidx };
      cmdCursor += dur;
      return entry;
    });
    const durationMs = cmdCursor - cursor;
    const clip: SceneClip = {
      scene,
      index: idx,
      startMs: cursor,
      durationMs,
      commands,
    };
    cursor = cmdCursor;
    return clip;
  });
  return { clips, totalMs: cursor };
}

function TimeRuler({ totalMs }: { totalMs: number }) {
  // Generate tick marks at sensible intervals
  const interval = totalMs <= 5000 ? 1000 : totalMs <= 30000 ? 5000 : 10000;
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += interval) {
    ticks.push(t);
  }

  return (
    <div className="relative h-5 w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
      {ticks.map((t) => {
        const pct = totalMs > 0 ? (t / totalMs) * 100 : 0;
        return (
          <div
            key={t}
            className="absolute top-0 flex h-full flex-col items-start"
            style={{ left: `${pct}%` }}
          >
            <div className="h-2 w-px bg-[var(--color-border-default)]" />
            <span className="pl-0.5 font-mono text-[9px] tabular-nums leading-none text-[var(--color-fg-muted)]">
              {formatTime(t)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TrackLabel({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  return (
    <div className="flex w-[72px] shrink-0 items-center gap-1.5 border-r border-[var(--color-border-subtle)] px-2 py-0.5">
      <Icon size={10} className="text-[var(--color-fg-muted)]" />
      <span className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--color-fg-muted)]">
        {label}
      </span>
    </div>
  );
}

export function TimelinePanel({
  onJumpTo,
}: {
  onJumpTo?: (byteOffset: number) => void;
}) {
  const ast = useEditorStore((s) => s.lastParse?.ast ?? null);

  const { clips, totalMs } = useMemo(
    () => (ast ? buildClips(ast.scenes) : { clips: [], totalMs: 0 }),
    [ast],
  );

  if (!ast || ast.scenes.length === 0) {
    return (
      <div className="flex h-full flex-col border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-100)]">
        <div className="flex items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5">
          <Clock size={11} className="text-[var(--color-fg-muted)]" />
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
            Timeline
          </span>
        </div>
        <div
          role="status"
          className="flex flex-1 items-center justify-center px-5 text-xs text-[var(--color-fg-muted)]"
        >
          Add <code className="mx-1 font-mono text-[var(--color-fg-secondary)]">scene &quot;...&quot;</code> blocks to populate the timeline.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--color-surface-100)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Clock size={11} className="text-[var(--color-fg-muted)]" />
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
            Timeline
          </span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums text-[var(--color-fg-muted)]">
          <span>{ast.scenes.length} scenes</span>
          <span className="text-[var(--color-border-default)]">/</span>
          <span>{formatTime(totalMs)}</span>
        </div>
      </div>

      {/* Time ruler */}
      <div className="flex">
        <div className="w-[72px] shrink-0 border-r border-[var(--color-border-subtle)]" />
        <div className="min-w-0 flex-1">
          <TimeRuler totalMs={totalMs} />
        </div>
      </div>

      {/* Tracks */}
      <div className="flex-1 overflow-y-auto">
        {/* Video track — scene clips with per-command segments */}
        <div className="flex h-9 border-b border-[var(--color-border-subtle)]">
          <TrackLabel icon={Film} label="Video" />
          <div className="relative min-w-0 flex-1">
            <div className="flex h-full items-stretch gap-px p-1">
              {clips.map((clip) => {
                const widthPct =
                  totalMs > 0 ? (clip.durationMs / totalMs) * 100 : 0;
                return (
                  <div
                    key={`scene-${clip.index}`}
                    className="flex h-full items-stretch gap-px overflow-hidden rounded-[var(--radius-xs)]"
                    style={{ width: `${widthPct}%` }}
                  >
                    {clip.commands.map((entry) => {
                      const segPct =
                        clip.durationMs > 0
                          ? (entry.durationMs / clip.durationMs) * 100
                          : 0;
                      return (
                        <button
                          key={`cmd-${clip.index}-${entry.index}`}
                          type="button"
                          onClick={() => onJumpTo?.(entry.cmd.span.start)}
                          className="flex items-center justify-center transition-[filter] hover:brightness-125 focus-visible:outline-1 focus-visible:outline-[var(--color-focus-ring)]"
                          style={{
                            width: `${segPct}%`,
                            backgroundColor: `color-mix(in oklch, ${verbColor(entry.cmd.verb)} 25%, transparent)`,
                          }}
                          title={`${entry.cmd.verb} (${entry.durationMs}ms) — line ${entry.cmd.span.line}`}
                          aria-label={`Jump to ${entry.cmd.verb} at line ${entry.cmd.span.line}`}
                        >
                          <span className="truncate px-0.5 font-mono text-[8px] uppercase tracking-[0.08em] text-[var(--color-fg-secondary)]">
                            {entry.cmd.verb}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {/* Scene name labels above clips */}
            <div className="pointer-events-none absolute inset-0 flex items-start">
              <div className="flex h-full w-full">
                {clips.map((clip) => {
                  const widthPct =
                    totalMs > 0 ? (clip.durationMs / totalMs) * 100 : 0;
                  return (
                    <div
                      key={`label-${clip.index}`}
                      className="flex h-full items-start pt-0.5 pl-1.5"
                      style={{ width: `${widthPct}%` }}
                    >
                      <span className="truncate text-[9px] font-medium text-[var(--color-fg-primary)]/70">
                        {clip.scene.name || `Scene ${clip.index + 1}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Voiceover track — placeholder */}
        <div className="flex h-7 border-b border-[var(--color-border-subtle)]">
          <TrackLabel icon={Mic2} label="Voice" />
          <div className="relative min-w-0 flex-1 p-1">
            <div className="flex h-full items-center px-2">
              <span className="text-[9px] italic text-[var(--color-fg-muted)]/60">
                Voiceover clips appear here after generation
              </span>
            </div>
          </div>
        </div>

        {/* Effects track — placeholder */}
        <div className="flex h-7 border-b border-[var(--color-border-subtle)]">
          <TrackLabel icon={Sparkles} label="FX" />
          <div className="relative min-w-0 flex-1 p-1">
            <div className="flex h-full items-center px-2">
              <span className="text-[9px] italic text-[var(--color-fg-muted)]/60">
                Auto-zoom, cursor effects, transitions
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

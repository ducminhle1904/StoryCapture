/**
 * TargetPicker — grouped Select replacing the old Display dropdown
 * (Plan 05-01). Groups per D-09:
 *   - Playwright browser (auto) — shown first when available;
 *     disabled with hint otherwise (Plan 05-02 enables).
 *   - Full screen — one entry per display.
 *   - Specific window — one entry per visible non-StoryCapture window.
 *
 * Styling matches the existing shadcn+Base UI Select pattern (D-10).
 * Window list refreshes on dropdown open only (Claude's discretion per
 * CONTEXT.md) + a manual refresh icon.
 */

import { useCallback, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import {
  PLAYWRIGHT_AUTO_TARGET,
  captureTargetKey,
  type CaptureTarget,
  type CaptureTargets,
} from "@/ipc/capture";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TargetPickerProps {
  availableTargets: CaptureTargets | null;
  value: CaptureTarget | null;
  onValueChange: (target: CaptureTarget) => void;
  onRefresh: () => void | Promise<void>;
  disabled?: boolean;
}

/** Truncate titles to 60 chars, dedupe (app, title) repeats with " (2)". */
function formatWindowLabel(
  app: string,
  title: string | null,
  occurrence: number,
): string {
  const baseTitle = title ?? "(untitled)";
  const truncated =
    baseTitle.length > 60 ? `${baseTitle.slice(0, 57)}…` : baseTitle;
  const suffix = occurrence > 1 ? ` (${occurrence})` : "";
  return `${app} — ${truncated}${suffix}`;
}

function labelForTarget(t: CaptureTarget, avail: CaptureTargets | null): string {
  if (t.kind === "display") {
    const id = typeof t.display_id === "bigint" ? Number(t.display_id) : t.display_id;
    const match = avail?.displays.find(
      (d) => (typeof d.id === "bigint" ? Number(d.id) : d.id) === id,
    );
    if (match) return `${match.name} — ${match.width_px}×${match.height_px}`;
    return `Display ${id}`;
  }
  if (t.kind === "window") {
    const id = typeof t.window_id === "bigint" ? Number(t.window_id) : t.window_id;
    const match = avail?.windows.find(
      (w) => (typeof w.window_id === "bigint" ? Number(w.window_id) : w.window_id) === id,
    );
    if (match) return formatWindowLabel(match.app_name, match.title, 1);
    return `Window ${id}`;
  }
  return "Playwright browser (auto)";
}

export function TargetPicker({
  availableTargets,
  value,
  onValueChange,
  onRefresh,
  disabled = false,
}: TargetPickerProps) {
  const [refreshing, setRefreshing] = useState(false);

  const handleOpen = useCallback(
    async (open: boolean) => {
      if (open) {
        // Re-enumerate windows on dropdown open (cheapest cadence —
        // avoids background jank).
        setRefreshing(true);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }
    },
    [onRefresh],
  );

  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);

  // Dedupe windows by (app, title) for repeat suffixes.
  const windowsWithOccurrence = useMemo(() => {
    if (!availableTargets) return [] as Array<{
      key: string;
      target: CaptureTarget;
      label: string;
    }>;
    const seen = new Map<string, number>();
    return availableTargets.windows.map((w) => {
      const id = typeof w.window_id === "bigint" ? Number(w.window_id) : w.window_id;
      const groupKey = `${w.app_name}|${w.title ?? ""}`;
      const occurrence = (seen.get(groupKey) ?? 0) + 1;
      seen.set(groupKey, occurrence);
      return {
        key: `window:${id}`,
        target: { kind: "window" as const, window_id: id },
        label: formatWindowLabel(w.app_name, w.title, occurrence),
      };
    });
  }, [availableTargets]);

  const selectedKey = value ? captureTargetKey(value) : "";

  // Base UI's Select expects scalar values; we key by the serialized
  // target key and keep a lookup map for onValueChange.
  const lookup = useMemo(() => {
    const map = new Map<string, CaptureTarget>();
    map.set(captureTargetKey(PLAYWRIGHT_AUTO_TARGET), PLAYWRIGHT_AUTO_TARGET);
    if (availableTargets) {
      for (const d of availableTargets.displays) {
        const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
        const t: CaptureTarget = { kind: "display", display_id: id };
        map.set(captureTargetKey(t), t);
      }
      for (const wi of windowsWithOccurrence) {
        map.set(wi.key, wi.target);
      }
    }
    return map;
  }, [availableTargets, windowsWithOccurrence]);

  const playwrightAvail = availableTargets?.playwright_auto_available ?? false;

  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <Select
          value={selectedKey}
          onValueChange={(v: unknown) => {
            if (typeof v === "string") {
              const t = lookup.get(v);
              if (t) onValueChange(t);
            }
          }}
          onOpenChange={handleOpen}
          disabled={disabled || !availableTargets}
        >
          <SelectTrigger
            id="target-select"
            aria-label="Capture target"
          >
            <SelectValue>
              {() =>
                value ? (
                  <span className="truncate">
                    {labelForTarget(value, availableTargets)}
                  </span>
                ) : (
                  <span className="text-[var(--color-fg-muted)]">
                    Select target
                  </span>
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectGroupLabel>Playwright browser</SelectGroupLabel>
              <SelectItem
                value={captureTargetKey(PLAYWRIGHT_AUTO_TARGET)}
                disabled={!playwrightAvail}
              >
                <span>
                  Playwright browser (auto){" "}
                  <span className="ml-1 rounded-sm bg-[var(--color-accent-primary)]/15 px-1 text-[9px] uppercase tracking-wider text-[var(--color-accent-primary)]">
                    Recommended
                  </span>
                </span>
                {!playwrightAvail ? (
                  <span className="ml-2 text-[var(--color-fg-muted)]">
                    · Launch a story to enable
                  </span>
                ) : null}
              </SelectItem>
            </SelectGroup>

            <SelectSeparator />

            <SelectGroup>
              <SelectGroupLabel>Full screen</SelectGroupLabel>
              {(availableTargets?.displays ?? []).map((d) => {
                const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
                const target: CaptureTarget = { kind: "display", display_id: id };
                return (
                  <SelectItem key={`display:${id}`} value={captureTargetKey(target)}>
                    Display {id} — {d.name} ({d.width_px}×{d.height_px})
                  </SelectItem>
                );
              })}
              {(!availableTargets || availableTargets.displays.length === 0) && (
                <div className="px-2 py-1 text-[11px] text-[var(--color-fg-muted)]">
                  No displays detected
                </div>
              )}
            </SelectGroup>

            <SelectSeparator />

            <SelectGroup>
              <SelectGroupLabel>Specific window</SelectGroupLabel>
              {windowsWithOccurrence.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-[var(--color-fg-muted)]">
                  No windows detected
                </div>
              ) : (
                windowsWithOccurrence.map((wi) => (
                  <SelectItem key={wi.key} value={wi.key}>
                    {wi.label}
                  </SelectItem>
                ))
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <button
        type="button"
        aria-label="Refresh capture targets"
        title="Refresh windows"
        onClick={handleManualRefresh}
        disabled={disabled || refreshing}
        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] text-[var(--color-fg-secondary)] transition-colors hover:bg-[var(--color-surface-300)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw
          size={11}
          aria-hidden="true"
          className={refreshing ? "animate-spin" : undefined}
        />
      </button>
    </div>
  );
}

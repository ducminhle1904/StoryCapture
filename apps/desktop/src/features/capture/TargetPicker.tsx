/**
 * TargetPicker for capture targets.
 */

import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type CaptureTarget, type CaptureTargets, captureTargetKey } from "@/ipc/capture";

interface TargetPickerProps {
  availableTargets: CaptureTargets | null;
  value: CaptureTarget | null;
  onValueChange: (target: CaptureTarget) => void;
  onRefresh: () => void | Promise<void>;
  disabled?: boolean;
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
  return "Select display";
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
        // Re-enumerate capture targets on dropdown open.
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

  const selectedKey = value ? captureTargetKey(value) : "";

  // Base UI Select expects scalar values.
  const lookup = useMemo(() => {
    const map = new Map<string, CaptureTarget>();
    if (availableTargets) {
      for (const d of availableTargets.displays) {
        const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
        const t: CaptureTarget = { kind: "display", display_id: id };
        map.set(captureTargetKey(t), t);
      }
    }
    return map;
  }, [availableTargets]);

  return (
    <div className="flex flex-col gap-1.5">
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
            <SelectTrigger id="target-select" aria-label="Capture target" className="min-w-0">
              <SelectValue>
                {() =>
                  value?.kind === "display" ? (
                    <span className="block min-w-0 flex-1 truncate text-left">
                      {labelForTarget(value, availableTargets)}
                    </span>
                  ) : (
                    <span className="text-[var(--color-fg-muted)]">Select display</span>
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-[min(var(--available-width),22rem)]">
              <SelectGroup>
                <SelectGroupLabel>Display</SelectGroupLabel>
                {(availableTargets?.displays ?? []).map((d) => {
                  const id = typeof d.id === "bigint" ? Number(d.id) : d.id;
                  const target: CaptureTarget = {
                    kind: "display",
                    display_id: id,
                  };
                  const label = `Display ${id} — ${d.name} (${d.width_px}×${d.height_px})`;
                  return (
                    <SelectItem key={`display:${id}`} value={captureTargetKey(target)}>
                      <span className="block truncate" title={label}>
                        {label}
                      </span>
                    </SelectItem>
                  );
                })}
                {(!availableTargets || availableTargets.displays.length === 0) && (
                  <div className="px-2 py-1 text-[11px] text-[var(--color-fg-muted)]">
                    No displays detected
                  </div>
                )}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <button
          type="button"
          aria-label="Refresh capture targets"
          title="Refresh displays"
          onClick={handleManualRefresh}
          disabled={disabled || refreshing}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-200)] text-[var(--color-fg-secondary)] transition-colors hover:bg-[var(--color-surface-300)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            size={11}
            aria-hidden="true"
            className={refreshing ? "animate-spin" : undefined}
          />
        </button>
      </div>
    </div>
  );
}

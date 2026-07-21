/**
 * TargetPicker for capture targets.
 */

import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Selector as AstryxSelector } from "@astryxdesign/core/Selector";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { type CaptureTarget, type CaptureTargets, captureTargetKey } from "@/ipc/capture";

interface TargetPickerProps {
  availableTargets: CaptureTargets | null;
  value: CaptureTarget | null;
  onValueChange: (target: CaptureTarget) => void;
  onRefresh: () => void | Promise<void>;
  disabled?: boolean;
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

  // Astryx Selector expects scalar values.
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
          <AstryxSelector
            label="Capture target"
            isLabelHidden
            placeholder="Select display"
            value={selectedKey}
            options={[
              {
                type: "section",
                title: "Display",
                options:
                  availableTargets && availableTargets.displays.length > 0
                    ? availableTargets.displays.map((display) => {
                        const id = typeof display.id === "bigint" ? Number(display.id) : display.id;
                        const target: CaptureTarget = { kind: "display", display_id: id };
                        return {
                          value: captureTargetKey(target),
                          label: `Display ${id} — ${display.name} (${display.width_px}×${display.height_px})`,
                        };
                      })
                    : [{ value: "no-displays", label: "No displays detected", disabled: true }],
              },
            ]}
            onChange={(nextValue) => {
              const target = lookup.get(nextValue);
              if (target) onValueChange(target);
            }}
            onPointerDown={() => void handleOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") void handleOpen(true);
            }}
            isDisabled={disabled || !availableTargets}
            width="100%"
          />
        </div>

        <AstryxButton
          label="Refresh capture targets"
          tooltip="Refresh displays"
          icon={
            <RefreshCw
              size={11}
              aria-hidden="true"
              className={refreshing ? "animate-spin" : undefined}
            />
          }
          isIconOnly
          size="sm"
          variant="ghost"
          onClick={handleManualRefresh}
          isDisabled={disabled || refreshing}
        />
      </div>
    </div>
  );
}

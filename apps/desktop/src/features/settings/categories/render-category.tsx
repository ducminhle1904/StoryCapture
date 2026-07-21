import {
  SegmentedControl as AstryxSegmentedControl,
  SegmentedControlItem as AstryxSegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Slider as AstryxSlider } from "@astryxdesign/core/Slider";
import { Switch as AstryxSwitch } from "@astryxdesign/core/Switch";
import type { OutputResolutionDto } from "@storycapture/shared-types";
import { useEffect, useState } from "react";
import { notifications } from "@/lib/notifications";
import { useAppSettingsStore } from "@/state/app-settings";
import { useOutputPrefsStore } from "@/state/output-prefs";
import { SettingsCard, SettingsPanel, SettingsRow } from "../settings-row";

type ResoKey = "p720" | "p1080" | "p1440" | "p2160";

function resolutionKey(r: OutputResolutionDto): ResoKey | "other" {
  if (r.kind === "p720") return "p720";
  if (r.kind === "p1080") return "p1080";
  if (r.kind === "p1440") return "p1440";
  if (r.kind === "p2160") return "p2160";
  return "other";
}

function fromResoKey(k: ResoKey): OutputResolutionDto {
  return { kind: k };
}

// Render defaults combine output-prefs (recorder/export knobs) and app_settings
// (queue-level defaults).
export function RenderCategory() {
  const settings = useAppSettingsStore((s) => s.settings);
  const patchRender = useAppSettingsStore((s) => s.patchRender);
  const recordingKnobs = useOutputPrefsStore((s) => s.recordingKnobs);
  const recordingDeliveryPolicy = useOutputPrefsStore((s) => s.recordingDeliveryPolicy);
  const exportKnobs = useOutputPrefsStore((s) => s.exportKnobs);
  const setRecordingKnob = useOutputPrefsStore((s) => s.setRecordingKnob);
  const setRecordingDeliveryPolicy = useOutputPrefsStore((s) => s.setRecordingDeliveryPolicy);
  const setExportKnob = useOutputPrefsStore((s) => s.setExportKnob);

  const resoKey = resolutionKey(recordingKnobs.resolution);
  const codec = exportKnobs.codec; // always "h264" today
  const hwOn = exportKnobs.hwEncoder === "auto";
  const savedParallelRenders = settings?.render.parallel_renders ?? 2;
  const [parallelDraft, setParallelDraft] = useState(savedParallelRenders);

  useEffect(() => {
    setParallelDraft(savedParallelRenders);
  }, [savedParallelRenders]);

  const saveParallelRenders = async (parallel_renders: number) => {
    if (parallel_renders === savedParallelRenders) return;
    try {
      await patchRender({ parallel_renders });
      notifications.success("Render defaults saved", {
        description: "Open projects will use this the next time they are opened.",
      });
    } catch (err) {
      notifications.error("Could not save render defaults", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <SettingsPanel title="Render defaults">
      <SettingsCard>
        <SettingsRow
          label="Recording policy"
          hint="Strict publishes only verified 1080p60 takes; Standard completes with truthful degraded evidence."
          control={
            <AstryxSegmentedControl
              size="sm"
              value={recordingDeliveryPolicy}
              onChange={(value) =>
                setRecordingDeliveryPolicy(value === "strict" ? "strict" : "best_effort")
              }
              label="Recording policy"
            >
              {[
                { value: "best_effort", label: "Standard" },
                { value: "strict", label: "Strict" },
              ].map((option) => (
                <AstryxSegmentedControlItem
                  key={option.value}
                  value={option.value}
                  label={typeof option.label === "string" ? option.label : option.value}
                  icon={typeof option.label === "string" ? undefined : option.label}
                />
              ))}
            </AstryxSegmentedControl>
          }
        />
        <SettingsRow
          label="Resolution"
          control={
            <AstryxSegmentedControl
              size="sm"
              value={resoKey === "other" ? "p1080" : resoKey}
              onChange={(v) => setRecordingKnob("resolution", fromResoKey(v as ResoKey))}
              label="Resolution"
            >
              {[
                { value: "p720", label: "720" },
                { value: "p1080", label: "1080" },
                { value: "p1440", label: "1440" },
                { value: "p2160", label: "4K" },
              ].map((option) => (
                <AstryxSegmentedControlItem
                  key={option.value}
                  value={option.value}
                  label={typeof option.label === "string" ? option.label : option.value}
                  icon={typeof option.label === "string" ? undefined : option.label}
                />
              ))}
            </AstryxSegmentedControl>
          }
        />
        <SettingsRow
          label="Codec"
          hint="Current encoder path ships H.264."
          control={
            <AstryxSegmentedControl
              size="sm"
              value={codec}
              label="Codec"
              onChange={() => {}}
              isDisabled
            >
              {[{ value: "h264", label: "H.264" }].map((option) => (
                <AstryxSegmentedControlItem
                  key={option.value}
                  value={option.value}
                  label={typeof option.label === "string" ? option.label : option.value}
                  icon={typeof option.label === "string" ? undefined : option.label}
                />
              ))}
            </AstryxSegmentedControl>
          }
        />
        <SettingsRow
          label="HW encoder"
          hint="Auto-detect VideoToolbox / NVENC / QSV / AMF"
          control={
            <AstryxSwitch
              label="HW encoder"
              isLabelHidden
              value={hwOn}
              onChange={(next) => setExportKnob("hwEncoder", next ? "auto" : "software")}
            />
          }
        />
        <SettingsRow
          label="Parallel renders"
          hint="Cap background jobs"
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10, width: 190 }}>
              <AstryxSlider
                label="Parallel renders"
                isLabelHidden
                value={settings?.render.parallel_renders ?? 2}
                min={1}
                max={6}
                step={1}
                onChange={(value: number) => {
                  if (typeof value === "number") setParallelDraft(value);
                }}
                onChangeEnd={() => void saveParallelRenders(parallelDraft)}
                onBlur={() => void saveParallelRenders(parallelDraft)}
              />
              <span style={{ width: 18, fontSize: 12, color: "var(--color-text-secondary)" }}>
                {parallelDraft}
              </span>
            </div>
          }
          last
        />
      </SettingsCard>
    </SettingsPanel>
  );
}

import type { OutputResolutionDto } from "@storycapture/shared-types";
import { ScSegmented, ScSlider, ScSwitch } from "@storycapture/ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
  const exportKnobs = useOutputPrefsStore((s) => s.exportKnobs);
  const setRecordingKnob = useOutputPrefsStore((s) => s.setRecordingKnob);
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
      toast.success("Render defaults saved", {
        description: "Open projects will use this the next time they are opened.",
      });
    } catch (err) {
      toast.error("Could not save render defaults", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <SettingsPanel title="Render defaults">
      <SettingsCard>
        <SettingsRow
          label="Resolution"
          control={
            <ScSegmented
              size="sm"
              value={resoKey === "other" ? "p1080" : resoKey}
              onValueChange={(v) => setRecordingKnob("resolution", fromResoKey(v as ResoKey))}
              options={[
                { value: "p720", label: "720" },
                { value: "p1080", label: "1080" },
                { value: "p1440", label: "1440" },
                { value: "p2160", label: "4K" },
              ]}
            />
          }
        />
        <SettingsRow
          label="Codec"
          hint="Current encoder path ships H.264."
          control={
            <ScSegmented size="sm" value={codec} options={[{ value: "h264", label: "H.264" }]} />
          }
        />
        <SettingsRow
          label="HW encoder"
          hint="Auto-detect VideoToolbox / NVENC / QSV / AMF"
          control={
            <ScSwitch
              checked={hwOn}
              onCheckedChange={(next) => setExportKnob("hwEncoder", next ? "auto" : "software")}
            />
          }
        />
        <SettingsRow
          label="Parallel renders"
          hint="Cap background jobs"
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10, width: 190 }}>
              <ScSlider
                value={settings?.render.parallel_renders ?? 2}
                min={1}
                max={6}
                step={1}
                onValueChange={(value) => {
                  if (typeof value === "number") setParallelDraft(value);
                }}
                onValueCommitted={() => void saveParallelRenders(parallelDraft)}
                onBlur={() => void saveParallelRenders(parallelDraft)}
              />
              <span style={{ width: 18, fontSize: 12, color: "var(--sc-text-3)" }}>
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

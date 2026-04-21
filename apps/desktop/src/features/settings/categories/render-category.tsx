import { ScSegmented, ScSlider, ScSwitch } from "@storycapture/ui";
import type { OutputResolutionDto } from "@storycapture/shared-types";

import { useOutputPrefsStore } from "@/state/output-prefs";
import {
  NotWiredCaption,
  SettingsCard,
  SettingsPanel,
  SettingsRow,
} from "../settings-row";

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

// Wired where it maps to Phase 13 output-prefs; placeholder for fields outside that store.
export function RenderCategory() {
  const recordingKnobs = useOutputPrefsStore((s) => s.recordingKnobs);
  const exportKnobs = useOutputPrefsStore((s) => s.exportKnobs);
  const setRecordingKnob = useOutputPrefsStore((s) => s.setRecordingKnob);
  const setExportKnob = useOutputPrefsStore((s) => s.setExportKnob);

  const resoKey = resolutionKey(recordingKnobs.resolution);
  const codec = exportKnobs.codec; // always "h264" today
  const hwOn = exportKnobs.hwEncoder !== "none";

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
          hint="H.264 ships today; HEVC and ProRes arrive with codec plan"
          control={
            <ScSegmented
              size="sm"
              value={codec}
              disabled
              options={[
                { value: "h264", label: "H.264" },
                { value: "hevc", label: "HEVC" },
                { value: "prores", label: "ProRes" },
              ]}
            />
          }
        />
        <SettingsRow
          label="HW encoder"
          hint="Auto-detect VideoToolbox / NVENC / QSV / AMF"
          control={
            <ScSwitch
              checked={hwOn}
              onCheckedChange={(next) => setExportKnob("hwEncoder", next ? "auto" : "none")}
            />
          }
        />
        <SettingsRow
          label="Parallel renders"
          hint="Cap background jobs"
          control={
            <div style={{ width: 160 }}>
              <ScSlider value={2} min={1} max={6} step={1} disabled />
            </div>
          }
          last
        />
      </SettingsCard>
      <NotWiredCaption>
        Resolution and HW encoder toggle write to the Phase 13 output-prefs
        store. Codec and parallel-renders are placeholders.
      </NotWiredCaption>
    </SettingsPanel>
  );
}

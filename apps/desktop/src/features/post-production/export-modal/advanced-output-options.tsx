/**
 * AdvancedOutputOptions — 8 export-only knobs grouped into 3 visual sub-groups.
 * Phase 13 ENC-13 + ENC-16 + CD-13-01. Conditional fields per encoder via
 * deriveQualityControls(). HW encoder list = probe + Software fallback.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { NumberField } from "@/components/ui/number-field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { probeHwEncoders } from "@/ipc/encode";
import {
  type AudioKnobs,
  type ExportContainer,
  type ExportDownscaleAlgo,
  type ExportRateControl,
  type ExportX264Preset,
  useOutputPrefsStore,
} from "@/state/output-prefs";

import * as copy from "./advanced-copy";
import { type QualityControlSpec, deriveQualityControls } from "./encoder-options-table";

type HwEncoderKind =
  | "auto"
  | "software"
  | "libx264"
  | "h264-videotoolbox"
  | "hevc-videotoolbox"
  | "h264-nvenc"
  | "hevc-nvenc"
  | "h264-qsv"
  | "h264-amf"
  | "libopenh264";

/** Serialized HardwareEncoderDto -> UI kebab identifier. */
const PROBE_TO_UI: Record<string, HwEncoderKind> = {
  "video-toolbox-h264": "h264-videotoolbox",
  "video-toolbox-hevc": "hevc-videotoolbox",
  "nvenc-h264": "h264-nvenc",
  "qsv-h264": "h264-qsv",
  "amf-h264": "h264-amf",
  "openh-264-software": "libopenh264",
};

const UI_LABEL: Record<HwEncoderKind, string> = {
  auto: "Auto",
  software: "Software (libx264)",
  libx264: "Software (libx264)",
  "h264-videotoolbox": "VideoToolbox H.264",
  "hevc-videotoolbox": "VideoToolbox HEVC",
  "h264-nvenc": "NVENC H.264",
  "hevc-nvenc": "NVENC HEVC",
  "h264-qsv": "QuickSync H.264",
  "h264-amf": "AMF H.264",
  libopenh264: "OpenH264 (fallback)",
};

interface ProbeShape {
  available?: unknown;
  preferred?: unknown;
}

function parseProbe(raw: unknown): HwEncoderKind[] {
  if (!raw || typeof raw !== "object") return [];
  const probe = raw as ProbeShape;
  const list = Array.isArray(probe.available) ? probe.available : [];
  const out: HwEncoderKind[] = [];
  for (const entry of list) {
    if (typeof entry === "string" && PROBE_TO_UI[entry]) {
      out.push(PROBE_TO_UI[entry]);
    }
  }
  return out;
}

function SubGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`grid gap-3 border-t border-[var(--color-border-subtle)] pt-4 mt-4 first:border-t-0 first:pt-0 first:mt-0 ${className ?? ""}`}
    >
      <div className="text-[13px] font-medium uppercase tracking-wide text-[var(--color-fg-secondary)] mb-2">
        {label}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-6 md:gap-y-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <span className="text-[11px] uppercase tracking-[0.18em] text-[var(--color-fg-muted)]">
        {label}
      </span>
      {children}
    </div>
  );
}

export function AdvancedOutputOptions() {
  const exportKnobs = useOutputPrefsStore((s) => s.exportKnobs);
  const setExportKnob = useOutputPrefsStore((s) => s.setExportKnob);

  const { data: probeRaw } = useQuery({
    queryKey: ["hw-encoders"],
    queryFn: probeHwEncoders,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const availableEncoders = useMemo(() => parseProbe(probeRaw), [probeRaw]);

  const isSoftwareOrAuto =
    exportKnobs.hwEncoder === "auto" ||
    exportKnobs.hwEncoder === "software" ||
    exportKnobs.hwEncoder === "libx264";
  const hwUnavailable =
    !isSoftwareOrAuto && !availableEncoders.find((e) => e === exportKnobs.hwEncoder);

  const quality = deriveQualityControls(exportKnobs.hwEncoder, exportKnobs.codec);
  const qualityValue = exportKnobs.qualityValue ?? qualityDefault(quality.qualityControl);

  const onHwEncoderChange = (v: string) => {
    // Reset qualityValue so the new control's default renders; user commit will write a real number.
    useOutputPrefsStore.setState((s) => ({
      exportKnobs: { ...s.exportKnobs, hwEncoder: v, qualityValue: null },
    }));
  };

  return (
    <div className="grid gap-4">
      <SubGroup label={copy.LABEL_GROUP_CONTAINER_CODEC}>
        <Field label={copy.LABEL_CONTAINER}>
          <Select
            value={exportKnobs.container}
            onValueChange={(v) => {
              if (typeof v === "string") setExportKnob("container", v as ExportContainer);
            }}
          >
            <SelectTrigger aria-label={copy.LABEL_CONTAINER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mp4">MP4</SelectItem>
              <SelectItem value="mov">MOV</SelectItem>
              <SelectItem value="webm" disabled>
                WebM (not yet supported)
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={copy.LABEL_CODEC}>
          <Select value={exportKnobs.codec} onValueChange={() => {}}>
            <SelectTrigger aria-label={copy.LABEL_CODEC}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="h264">H.264</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </SubGroup>

      <SubGroup label={copy.LABEL_GROUP_ENCODER_QUALITY}>
        <Field label={copy.LABEL_HW_ENCODER}>
          <Select
            value={exportKnobs.hwEncoder}
            onValueChange={(v) => {
              if (typeof v === "string") onHwEncoderChange(v);
            }}
          >
            <SelectTrigger aria-label={copy.LABEL_HW_ENCODER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{UI_LABEL.auto}</SelectItem>
              {availableEncoders.map((e) => (
                <SelectItem key={e} value={e}>
                  {UI_LABEL[e]}
                </SelectItem>
              ))}
              <SelectItem value="software">{UI_LABEL.software}</SelectItem>
              {hwUnavailable ? (
                <SelectItem value={exportKnobs.hwEncoder} disabled>
                  {exportKnobs.hwEncoder} {copy.SUFFIX_HW_UNAVAILABLE}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </Field>
        {hwUnavailable ? (
          <output
            aria-live="polite"
            className="text-xs text-[var(--color-warning,var(--color-accent-primary))]"
          >
            {copy.WARN_HW_UNAVAILABLE(exportKnobs.hwEncoder)}
          </output>
        ) : null}
        {quality.qualityControl.kind === "auto-hide" ? (
          <div className="text-xs text-[var(--color-fg-muted)]">{quality.qualityControl.note}</div>
        ) : (
          <>
            {quality.rateControlOptions.length > 0 ? (
              <Field label={copy.LABEL_RATE_CONTROL}>
                <RadioGroup
                  value={exportKnobs.rateControl}
                  onValueChange={(v) => {
                    if (typeof v === "string") setExportKnob("rateControl", v as ExportRateControl);
                  }}
                  className="flex flex-wrap gap-4"
                >
                  {quality.rateControlOptions.map((opt) => (
                    <span
                      key={opt.value}
                      className="flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]"
                    >
                      <RadioGroupItem value={opt.value} disabled={opt.locked} />
                      {opt.value.toUpperCase()}
                    </span>
                  ))}
                </RadioGroup>
              </Field>
            ) : null}
            {quality.qualityControl.kind === "slider-crf" ||
            quality.qualityControl.kind === "slider-cq" ? (
              <Field label={copy.LABEL_QUALITY_SLIDER}>
                <Slider
                  min={quality.qualityControl.min}
                  max={quality.qualityControl.max}
                  value={qualityValue}
                  onValueChange={(v) => {
                    if (typeof v === "number") setExportKnob("qualityValue", v);
                  }}
                />
              </Field>
            ) : quality.qualityControl.kind === "number-bitrate-mbps" ? (
              <Field label={copy.LABEL_BITRATE_MBPS}>
                <NumberField
                  min={quality.qualityControl.min}
                  max={quality.qualityControl.max}
                  value={qualityValue}
                  onChange={(n) => setExportKnob("qualityValue", typeof n === "number" ? n : null)}
                />
              </Field>
            ) : null}
            {quality.presetOptions.length > 0 ? (
              <Field label={copy.LABEL_PRESET}>
                <Select
                  value={exportKnobs.x264Preset}
                  onValueChange={(v) => {
                    if (typeof v === "string") setExportKnob("x264Preset", v as ExportX264Preset);
                  }}
                >
                  <SelectTrigger aria-label={copy.LABEL_PRESET}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {quality.presetOptions.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {quality.note ? (
              <div className="text-xs text-[var(--color-fg-muted)]">{quality.note}</div>
            ) : null}
          </>
        )}
      </SubGroup>

      <SubGroup label={copy.LABEL_GROUP_KEYFRAME_AUDIO} className="md:col-span-2">
        <Field label={copy.LABEL_KEYFRAME}>
          <NumberField
            min={1}
            max={10}
            value={exportKnobs.keyframeSec}
            onChange={(n) => setExportKnob("keyframeSec", typeof n === "number" ? n : 2)}
          />
        </Field>
        <Field label={copy.LABEL_DOWNSCALE}>
          <RadioGroup
            value={exportKnobs.downscaleAlgo}
            onValueChange={(v) => {
              if (typeof v === "string") setExportKnob("downscaleAlgo", v as ExportDownscaleAlgo);
            }}
            className="flex flex-wrap gap-4"
          >
            {(["lanczos", "bicubic", "bilinear"] as const).map((opt) => (
              <span
                key={opt}
                className="flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]"
              >
                <RadioGroupItem value={opt} />
                {opt}
              </span>
            ))}
          </RadioGroup>
        </Field>
        <Field label={copy.LABEL_AUDIO_CODEC}>
          <Select
            value={exportKnobs.audio.codec}
            onValueChange={(v) => {
              if (typeof v === "string")
                setExportKnob("audio", {
                  ...exportKnobs.audio,
                  codec: v as AudioKnobs["codec"],
                });
            }}
          >
            <SelectTrigger aria-label={copy.LABEL_AUDIO_CODEC}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="aac">AAC</SelectItem>
              <SelectItem value="opus" disabled>
                Opus (WebM only — not yet supported)
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={copy.LABEL_AUDIO_BITRATE}>
          <div className="flex items-center gap-3">
            <Slider
              min={64}
              max={320}
              step={32}
              value={exportKnobs.audio.bitrateKbps}
              onValueChange={(v) => {
                if (typeof v === "number")
                  setExportKnob("audio", { ...exportKnobs.audio, bitrateKbps: v });
              }}
            />
            <span className="text-xs tabular-nums text-[var(--color-fg-muted)] min-w-[4ch] text-right">
              {exportKnobs.audio.bitrateKbps}
            </span>
          </div>
        </Field>
        <Field label={copy.LABEL_AUDIO_CHANNELS}>
          <RadioGroup
            value={String(exportKnobs.audio.channels)}
            onValueChange={(v) => {
              if (typeof v === "string")
                setExportKnob("audio", {
                  ...exportKnobs.audio,
                  channels: (Number(v) === 1 ? 1 : 2) as 1 | 2,
                });
            }}
            className="flex gap-4"
          >
            <span className="flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]">
              <RadioGroupItem value="1" />
              Mono
            </span>
            <span className="flex items-center gap-2 text-xs text-[var(--color-fg-secondary)]">
              <RadioGroupItem value="2" />
              Stereo
            </span>
          </RadioGroup>
        </Field>
      </SubGroup>
    </div>
  );
}

function qualityDefault(spec: QualityControlSpec): number {
  switch (spec.kind) {
    case "slider-crf":
    case "slider-cq":
    case "number-bitrate-mbps":
      return spec.default;
    default:
      return 0;
  }
}
